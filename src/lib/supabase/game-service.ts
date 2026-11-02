import { Chess, Square } from "chess.js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import * as db from "@/lib/db/games";
import {
  PieceType,
  getLegalPieceTypes,
  rollAllowedPieceType,
  isMoveAllowedForRolledPiece,
} from "@/lib/chaos-chess";
import type {
  CreateGameResult,
  DbGame,
  DbGamePlayer,
  GameResultReason,
  JoinGameResult,
  RecordMoveResult,
} from "@/types/db";

export type {
  DbGame,
  DbGameMove,
  DbGamePlayer,
  GameColor,
  GameStatus,
} from "@/types/db";
export { getGame, getGamePlayers } from "@/lib/db/games";

export type CreateLobbyResult = CreateGameResult;
export type JoinLobbyResult = JoinGameResult;

export type MakeMoveInput = {
  gameId: string;
  from: Square;
  to: Square;
  promotion?: "n" | "b" | "r" | "q";
};

export type MakeMoveResult = RecordMoveResult;

export type FastStateSyncPayload = {
  type: "state_sync";
  game: DbGame;
};

const DEBUG_GAME_SERVICE = true;

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

function waitForChannelSubscribed(channel: RealtimeChannel) {
  dlog("waitForChannelSubscribed:start", { topic: channel.topic });

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cb();
    };

    const timeout = setTimeout(() => {
      dlog("waitForChannelSubscribed:timeout", { topic: channel.topic });
      finish(() => reject(new Error("Realtime kanalına bağlanılamadı.")));
    }, 4000);

    channel.subscribe((status) => {
      dlog("channel:status", { topic: channel.topic, status });

      if (status === "SUBSCRIBED") {
        finish(() => resolve());
        return;
      }

      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        finish(() =>
          reject(new Error(`Realtime bağlantı hatası: ${status}`))
        );
      }
    });
  });
}

export async function ensureSession(): Promise<string> {
  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession();

  if (sessionError) {
    dlog("ensureSession:getSession:error", sessionError);
    throw new Error(sessionError.message);
  }

  const existingUserId = sessionData.session?.user.id;
  if (existingUserId) {
    dlog("ensureSession:existing", { userId: existingUserId });
    return existingUserId;
  }

  dlog("ensureSession:no-session -> signInAnonymously");

  const { data, error } = await supabase.auth.signInAnonymously();

  if (error) {
    dlog("ensureSession:anon:error", error);
    throw new Error(error.message);
  }

  const userId = data.user?.id ?? data.session?.user.id;

  if (!userId) {
    dlog("ensureSession:anon:no-user");
    throw new Error("Anon oturum oluşturulamadı.");
  }

  dlog("ensureSession:anon:created", { userId });
  return userId;
}

export async function getCurrentUserIdOrThrow(): Promise<string> {
  return ensureSession();
}

export function createFastGameChannel(gameId: string) {
  const channel = supabase.channel(`game-fast-${gameId}`, {
    config: {
      broadcast: {
        self: false,
      },
    },
  });

  dlog("createFastGameChannel", { gameId, topic: channel.topic });
  return channel;
}

export async function subscribeToFastGame(
  gameId: string,
  onStateSync: (payload: FastStateSyncPayload) => void
) {
  const channel = createFastGameChannel(gameId);
  dlog("subscribeToFastGame:create", { gameId, topic: channel.topic });

  channel.on("broadcast", { event: "state_sync" }, ({ payload }) => {
    dlog("subscribeToFastGame:received", payload);
    onStateSync(payload as FastStateSyncPayload);
  });

  try {
    await waitForChannelSubscribed(channel);
    dlog("subscribeToFastGame:subscribed", { gameId, topic: channel.topic });
  } catch (error) {
    dlog("subscribeToFastGame:error", { gameId, error });
    await supabase.removeChannel(channel);
    throw error;
  }

  return () => {
    dlog("subscribeToFastGame:cleanup", { gameId, topic: channel.topic });
    void supabase.removeChannel(channel);
  };
}

export async function broadcastFastStateSync(game: DbGame) {
  // supabase.channel() aynı topic için mevcut kanalı döndürür. Oda bu kanala
  // aboneyse gönderimden sonra kapatılmamalı, yoksa oyuncu rakibini duyamaz.
  const topic = `realtime:game-fast-${game.id}`;
  const reusesLiveChannel = supabase
    .getChannels()
    .some((existing) => existing.topic === topic);
  const channel = createFastGameChannel(game.id);

  dlog("broadcastFastStateSync:start", {
    gameId: game.id,
    moveCount: game.move_count,
    fen: game.fen,
    allowedPieceType: game.allowed_piece_type,
    currentTurn: game.current_turn,
    status: game.status,
  });

  try {
    const response = await channel.send({
      type: "broadcast",
      event: "state_sync",
      payload: {
        type: "state_sync",
        game,
      } satisfies FastStateSyncPayload,
    });

    dlog("broadcastFastStateSync:sent", {
      gameId: game.id,
      response,
    });
  } catch (error) {
    dlog("broadcastFastStateSync:error", {
      gameId: game.id,
      error,
    });
  } finally {
    if (!reusesLiveChannel) {
      setTimeout(() => {
        dlog("broadcastFastStateSync:cleanup", { gameId: game.id });
        void supabase.removeChannel(channel);
      }, 300);
    }
  }
}

export function simulateMoveLocally(params: {
  fen: string;
  allowedPieceType: PieceType | null;
  from: Square;
  to: Square;
  promotion?: "n" | "b" | "r" | "q";
}) {
  const { fen, allowedPieceType, from, to, promotion } = params;

  const chess = new Chess(fen);

  if (!allowedPieceType) {
    throw new Error("Bu tur için taş sonucu yok.");
  }

  if (!isMoveAllowedForRolledPiece(chess, from, to, allowedPieceType)) {
    throw new Error("Bu hamle zar sonucuna uygun değil.");
  }

  const candidateMoves = chess
    .moves({ square: from, verbose: true })
    .filter((move) => move.to === to && move.piece === allowedPieceType);

  if (candidateMoves.length === 0) {
    throw new Error("Geçersiz hamle.");
  }

  const needsPromotion = candidateMoves.some((move) => !!move.promotion);
  const finalPromotion = needsPromotion ? promotion ?? "q" : undefined;

  const moveResult = chess.move({
    from,
    to,
    ...(finalPromotion ? { promotion: finalPromotion } : {}),
  });

  if (!moveResult) {
    throw new Error("Hamle uygulanamadı.");
  }

  return {
    fenAfter: chess.fen(),
  };
}

export async function createLobby(): Promise<CreateLobbyResult> {
  const userId = await getCurrentUserIdOrThrow();
  dlog("createLobby:start", { userId });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lobbyCode = generateLobbyCode();
    dlog("createLobby:attempt", { attempt, lobbyCode });

    try {
      const result = await db.createGame(lobbyCode);
      dlog("createLobby:done", result);
      return result;
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
  const userId = await getCurrentUserIdOrThrow();
  return db.getPlayerForGame(gameId, userId);
}

async function finishJoin(result: JoinGameResult): Promise<JoinLobbyResult> {
  dlog("join:done", result);

  if (result.activated) {
    await broadcastFastStateSync(result.game);
  }

  return result;
}

export async function joinGame(gameId: string): Promise<JoinLobbyResult> {
  await ensureSession();
  return finishJoin(await db.joinGame(gameId));
}

export async function joinLobbyByCode(code: string): Promise<JoinLobbyResult> {
  await ensureSession();
  return finishJoin(await db.joinGameByCode(normalizeLobbyCode(code)));
}

export async function rollForCurrentTurn(gameId: string): Promise<DbGame> {
  dlog("rollForCurrentTurn:start", { gameId });

  const game = await db.getGame(gameId);

  if (game.status !== "active") {
    throw new Error("Oyun aktif değil.");
  }

  if (game.allowed_piece_type) {
    dlog("rollForCurrentTurn:already-rolled", {
      gameId,
      allowedPieceType: game.allowed_piece_type,
    });
    return game;
  }

  const myPlayer = await getMyPlayerForGame(gameId);
  if (!myPlayer) {
    throw new Error("Bu oyunun oyuncusu değilsin.");
  }

  if (game.current_turn !== myPlayer.color) {
    throw new Error("Sıra sende değil.");
  }

  dlog("rollForCurrentTurn:context", {
    gameId,
    myPlayer,
    currentTurn: game.current_turn,
    fen: game.fen,
  });

  const chess = new Chess(game.fen);
  const rolled = rollAllowedPieceType(chess);

  dlog("rollForCurrentTurn:rolled", {
    gameId,
    rolled,
    legalMovesCount: chess.moves({ verbose: true }).length,
  });

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

  await broadcastFastStateSync(updated);

  return updated;
}

export async function makeMove(input: MakeMoveInput): Promise<MakeMoveResult> {
  const userId = await getCurrentUserIdOrThrow();
  const { gameId, from, to, promotion } = input;

  dlog("makeMove:start", { gameId, userId, from, to, promotion });

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

  if (!game.allowed_piece_type) {
    throw new Error("Bu tur için zar sonucu bulunamadı.");
  }

  dlog("makeMove:context", {
    gameId,
    userId,
    myPlayer,
    gameStatus: game.status,
    currentTurn: game.current_turn,
    allowedPieceType: game.allowed_piece_type,
    moveCount: game.move_count,
    fenBefore: game.fen,
  });

  const chess = new Chess(game.fen);

  const legalMoves = chess.moves({ square: from, verbose: true });
  dlog("makeMove:legalMovesFromSquare", {
    from,
    legalMoves,
  });

  if (!isMoveAllowedForRolledPiece(chess, from, to, game.allowed_piece_type)) {
    throw new Error("Bu hamle gelen taş türüne uygun değil.");
  }

  const candidateMoves = chess
    .moves({ square: from, verbose: true })
    .filter(
      (move) => move.to === to && move.piece === game.allowed_piece_type
    );

  if (candidateMoves.length === 0) {
    throw new Error("Geçersiz hamle.");
  }

  const needsPromotion = candidateMoves.some((move) => !!move.promotion);
  const finalPromotion = needsPromotion ? promotion ?? "q" : undefined;

  const moveResult = chess.move({
    from,
    to,
    ...(finalPromotion ? { promotion: finalPromotion } : {}),
  });

  if (!moveResult) {
    throw new Error("Hamle uygulanamadı.");
  }

  const fenAfter = chess.fen();
  const moveNumber = game.move_count + 1;

  dlog("makeMove:applied-local", {
    from,
    to,
    fenAfter,
    moveNumber,
    moveSan: moveResult.san,
    nextTurn: chess.turn(),
  });

  let resultReason: GameResultReason | null = null;
  let nextPieceType: PieceType | null = null;

  if (chess.isCheckmate()) {
    resultReason = "checkmate";
  } else if (chess.isStalemate()) {
    resultReason = "stalemate";
  } else if (chess.isDraw()) {
    resultReason = "draw";
  } else {
    nextPieceType = rollAllowedPieceType(chess);
  }

  const result = await db.saveMove({
    gameId,
    moveNumber,
    pieceType: moveResult.piece,
    from,
    to,
    promotion: finalPromotion ?? null,
    san: moveResult.san ?? null,
    uci: `${from}${to}${finalPromotion ?? ""}`,
    fenAfter,
    resultReason,
    nextPieceType,
    nextLegalPieceTypes: nextPieceType ? getLegalPieceTypes(chess) : null,
  });

  dlog("makeMove:saved", result);

  await broadcastFastStateSync(result.game);

  dlog("makeMove:done", {
    gameId,
    moveCount: result.game.move_count,
    allowedPieceType: result.game.allowed_piece_type,
    status: result.game.status,
  });

  return result;
}

export async function resignGame(gameId: string): Promise<DbGame> {
  await ensureSession();
  dlog("resignGame:start", { gameId });

  const updated = await db.finishGame(gameId, "resign");

  dlog("resignGame:updated", updated);

  await broadcastFastStateSync(updated);

  return updated;
}
