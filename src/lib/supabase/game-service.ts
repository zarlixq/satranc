import { Chess, DEFAULT_POSITION, Square } from "chess.js";
import { supabase } from "@/lib/supabase/client";
import * as db from "@/lib/db/games";
import {
  PieceType,
  PromotionChoice,
  applyChaosMove,
  determineOutcome,
  getLegalPieceTypes,
  rollAllowedPieceType,
} from "@/lib/chaos-chess";
import { broadcastGameState } from "@/lib/realtime/game-channel";
import type {
  CreateGameResult,
  DbGame,
  DbGamePlayer,
  JoinGameResult,
  RecordMoveResult,
} from "@/types/db";

export type { DbGame, DbGamePlayer } from "@/types/db";
export { GameNotFoundError, getGame, getGamePlayers } from "@/lib/db/games";

export type MakeMoveInput = {
  gameId: string;
  from: Square;
  to: Square;
  promotion?: PromotionChoice;
};

const DEBUG_GAME_SERVICE = process.env.NEXT_PUBLIC_DEBUG === "true";

function dlog(label: string, data?: unknown) {
  if (!DEBUG_GAME_SERVICE) return;
  const now = new Date().toISOString();
  console.log(`[GAME-SERVICE ${now}] ${label}`, data ?? "");
}

function normalizeLobbyCode(code: string) {
  return code.toUpperCase().replace(/\s+/g, "").trim();
}

function generateLobbyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";

  for (let i = 0; i < 6; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

async function resolveSession(): Promise<string> {
  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession();

  if (sessionError) {
    dlog("ensureSession:getSession:error", sessionError);
    throw new Error("Oturum okunamadı. Bağlantını kontrol et.");
  }

  const existingUserId = sessionData.session?.user.id;
  if (existingUserId) return existingUserId;

  dlog("ensureSession:no-session -> signInAnonymously");

  const { data, error } = await supabase.auth.signInAnonymously();

  if (error) {
    dlog("ensureSession:anon:error", error);

    if (
      error.code === "anonymous_provider_disabled" ||
      /anonymous sign-ins are disabled/i.test(error.message)
    ) {
      throw new Error(
        "Anonim giriş kapalı olduğu için oyuna girilemiyor. Supabase panelinde Authentication > Sign In / Providers altından Anonymous Sign-Ins seçeneğini aç."
      );
    }

    throw new Error("Oturum açılamadı. Bağlantını kontrol edip tekrar dene.");
  }

  const userId = data.user?.id ?? data.session?.user.id;

  if (!userId) {
    throw new Error("Anon oturum oluşturulamadı.");
  }

  dlog("ensureSession:anon:created", { userId });
  return userId;
}

// Aynı anda gelen çağrılar tek oturum paylaşır; aksi halde her biri ayrı anonim
// kullanıcı açar ve oyuncu kendi oyununa erişemez hale gelebilir.
let sessionInFlight: Promise<string> | null = null;

export function ensureSession(): Promise<string> {
  if (!sessionInFlight) {
    sessionInFlight = resolveSession().finally(() => {
      sessionInFlight = null;
    });
  }

  return sessionInFlight;
}

export function simulateMoveLocally(params: {
  fen: string;
  allowedPieceType: PieceType | null;
  from: Square;
  to: Square;
  promotion?: PromotionChoice;
}) {
  return { fenAfter: applyChaosMove(params).fenAfter };
}

export async function createLobby(): Promise<CreateGameResult> {
  await ensureSession();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lobbyCode = generateLobbyCode();
    dlog("createLobby:attempt", { attempt, lobbyCode });

    try {
      return await db.createGame(lobbyCode);
    } catch (error) {
      dlog("createLobby:error", error);

      if (!(error instanceof db.DbError) || error.code !== "23505") {
        throw error;
      }
    }
  }

  throw new Error("Lobi kodu üretilemedi. Tekrar dene.");
}

export async function getMyPlayerForGame(
  gameId: string
): Promise<DbGamePlayer | null> {
  const userId = await ensureSession();
  return db.getPlayerForGame(gameId, userId);
}

export async function joinLobbyByCode(code: string): Promise<JoinGameResult> {
  await ensureSession();
  const result = await db.joinGameByCode(normalizeLobbyCode(code));
  dlog("joinLobbyByCode:done", result);
  // Lobi sahibi başlangıcı postgres_changes ile öğrenir.
  return result;
}

export async function rollForCurrentTurn(gameId: string): Promise<DbGame> {
  await ensureSession();
  const game = await db.getGame(gameId);

  if (game.status !== "active") {
    throw new Error("Oyun aktif değil.");
  }

  if (game.allowed_piece_type) {
    return game;
  }

  const myPlayer = await getMyPlayerForGame(gameId);
  if (!myPlayer) {
    throw new Error("Bu oyunun oyuncusu değilsin.");
  }

  if (game.current_turn !== myPlayer.color) {
    throw new Error("Sıra sende değil.");
  }

  const chess = new Chess(game.fen);
  const rolled = rollAllowedPieceType(chess);

  if (!rolled) {
    throw new Error("Bu pozisyonda legal taş türü yok.");
  }

  const updated = await db.saveDiceRoll({
    gameId,
    moveNumber: game.move_count + 1,
    rolledPieceType: rolled,
    legalPieceTypes: getLegalPieceTypes(chess),
  });

  dlog("rollForCurrentTurn:updated", updated);
  await broadcastGameState(updated);
  return updated;
}

// Bir pozisyonun üçüncü kez oluşması için son geri dönüşsüz hamleden sonra en az
// 8 yarım hamle gerekir; daha azında geçmişi okumaya gerek yok.
const MIN_HALFMOVES_FOR_REPETITION = 8;

async function loadPriorFens(gameId: string, fenAfter: string) {
  const halfmoveClock = Number(fenAfter.split(" ")[4]);
  if (halfmoveClock < MIN_HALFMOVES_FOR_REPETITION) return [];

  return [DEFAULT_POSITION, ...(await db.getGameFens(gameId))];
}

export async function makeMove(input: MakeMoveInput): Promise<RecordMoveResult> {
  const { gameId, from, to, promotion } = input;
  await ensureSession();
  dlog("makeMove:start", input);

  const game = await db.getGame(gameId);
  if (game.status !== "active") {
    throw new Error("Oyun aktif değil.");
  }

  const myPlayer = await getMyPlayerForGame(gameId);
  if (!myPlayer) {
    throw new Error("Bu oyunun oyuncusu değilsin.");
  }

  if (game.current_turn !== myPlayer.color) {
    throw new Error("Sıra sende değil.");
  }

  const { chess, move, finalPromotion, fenAfter } = applyChaosMove({
    fen: game.fen,
    allowedPieceType: game.allowed_piece_type,
    from,
    to,
    promotion,
  });

  const resultReason = determineOutcome(
    chess,
    await loadPriorFens(gameId, fenAfter)
  );
  const nextPieceType = resultReason ? null : rollAllowedPieceType(chess);

  const result = await db.saveMove({
    gameId,
    moveNumber: game.move_count + 1,
    pieceType: move.piece,
    from,
    to,
    promotion: finalPromotion ?? null,
    san: move.san ?? null,
    uci: `${from}${to}${finalPromotion ?? ""}`,
    fenAfter,
    resultReason,
    nextPieceType,
    nextLegalPieceTypes: nextPieceType ? getLegalPieceTypes(chess) : null,
  });

  dlog("makeMove:saved", result);
  await broadcastGameState(result.game);
  return result;
}

export async function resignGame(gameId: string): Promise<DbGame> {
  await ensureSession();
  const updated = await db.finishGame(gameId, "resign");
  dlog("resignGame:updated", updated);
  await broadcastGameState(updated);
  return updated;
}
