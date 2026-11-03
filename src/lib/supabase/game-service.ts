import { Chess, Square } from "chess.js";
import type { PostgrestError, RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import {
  PieceType,
  getLegalPieceTypes,
  isMoveAllowedForRolledPiece,
} from "@/lib/chaos-chess";

/*
 * Veritabanı yazma işlemleri yalnızca SECURITY DEFINER RPC'lerle yapılır
 * (create_game, join_game, join_game_by_code, save_dice_roll, record_move,
 * finish_game). Tablolarda istemciye sadece SELECT yetkisi var; RLS de
 * kullanıcıyı yalnızca oyuncusu olduğu oyunlarla sınırlar. Bu yüzden burada
 * doğrudan .insert()/.update() KULLANILMAMALI.
 */

export type GameStatus = "waiting" | "active" | "finished" | "cancelled";
export type GameColor = "w" | "b";

export type DbGame = {
  id: string;
  created_by: string;
  lobby_code: string;
  status: GameStatus;
  fen: string;
  current_turn: GameColor;
  allowed_piece_type: PieceType | null;
  winner_user_id: string | null;
  result_reason:
    | "checkmate"
    | "stalemate"
    | "draw"
    | "resign"
    | "timeout"
    | "abandon"
    | null;
  move_count: number;
  started_at: string | null;
  finished_at: string | null;
  last_move_at: string | null;
  created_at: string;
  updated_at: string;
  /** Her UPDATE'te trigger ile artar; senkronizasyonda sıralama için kullanılır. */
  version: number;
};

export type DbGamePlayer = {
  id: string;
  game_id: string;
  user_id: string;
  color: GameColor;
  is_host: boolean;
  joined_at: string;
  created_at: string;
};

export type DbGameMove = {
  id: number;
  game_id: string;
  user_id: string;
  move_number: number;
  color: GameColor;
  piece_type: PieceType;
  allowed_piece_type: PieceType;
  from_square: string;
  to_square: string;
  promotion: "n" | "b" | "r" | "q" | null;
  san: string | null;
  uci: string | null;
  fen_before: string;
  fen_after: string;
  created_at: string;
};

export type CreateLobbyResult = {
  game: DbGame;
  player: DbGamePlayer;
};

export type JoinLobbyResult = {
  game: DbGame;
  player: DbGamePlayer;
};

export type MakeMoveInput = {
  gameId: string;
  from: Square;
  to: Square;
  promotion?: "n" | "b" | "r" | "q";
};

export type MakeMoveResult = {
  game: DbGame;
  move: DbGameMove;
};

export type FastStateSyncPayload = {
  type: "state_sync";
  game: DbGame;
};

const DEBUG_GAME_SERVICE = process.env.NODE_ENV !== "production";

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

function pickRandom<T>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function rpcError(error: PostgrestError | null, fallback: string): Error {
  return new Error(error?.message || fallback);
}

/* ------------------------------------------------------------------ */
/* Oturum                                                              */
/* ------------------------------------------------------------------ */

let sessionPromise: Promise<string> | null = null;

async function resolveSession(): Promise<string> {
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
    throw new Error("Anon oturum oluşturulamadı.");
  }

  dlog("ensureSession:anon:created", { userId });
  return userId;
}

/**
 * Aynı anda gelen çağrılar tek bir anonim kullanıcı üretsin diye paylaşılan
 * promise kullanılır (aksi halde paralel çağrılar iki ayrı anon kullanıcı
 * oluşturabilir).
 */
export function ensureSession(): Promise<string> {
  if (!sessionPromise) {
    sessionPromise = resolveSession().finally(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

export async function getCurrentUserIdOrThrow(): Promise<string> {
  return ensureSession();
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

type GameChannelEntry = {
  channel: RealtimeChannel;
  listeners: Set<(payload: FastStateSyncPayload) => void>;
  ready: Promise<void>;
};

/**
 * Oyun başına TEK kanal. supabase.channel(topic) aynı topic için mevcut kanalı
 * döndürdüğünden, gönderim için ayrı kanal açıp kapatmak odanın aboneliğini de
 * kapatıyordu. Kanal artık burada referans sayımıyla yönetiliyor.
 */
const gameChannels = new Map<string, GameChannelEntry>();

function gameTopic(gameId: string) {
  return `game-fast-${gameId}`;
}

function waitForChannelSubscribed(channel: RealtimeChannel) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (cb: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cb();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Realtime kanalına bağlanılamadı.")));
    }, 8000);

    channel.subscribe((status, err) => {
      dlog("channel:status", { topic: channel.topic, status, err });

      if (status === "SUBSCRIBED") {
        finish(() => resolve());
        return;
      }

      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        finish(() => reject(new Error(`Realtime bağlantı hatası: ${status}`)));
      }
    });
  });
}

function emit(gameId: string, game: DbGame) {
  const entry = gameChannels.get(gameId);
  if (!entry) return;
  const payload: FastStateSyncPayload = { type: "state_sync", game };
  for (const listener of entry.listeners) listener(payload);
}

function getOrCreateGameChannel(gameId: string): GameChannelEntry {
  const existing = gameChannels.get(gameId);
  if (existing) return existing;

  const channel = supabase.channel(gameTopic(gameId), {
    config: { broadcast: { self: false } },
  });

  // 1) Hızlı yol: hamleyi yapan istemcinin yayınladığı durum.
  channel.on("broadcast", { event: "state_sync" }, ({ payload }) => {
    const p = payload as FastStateSyncPayload;
    if (p?.type === "state_sync" && p.game?.id === gameId) emit(gameId, p.game);
  });

  // 2) Güvenilir yol: veritabanındaki gerçek değişiklik (RLS'e tabi).
  //    Yayın kaçsa bile (sekme kapandı, ağ koptu) durum buradan gelir.
  channel.on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${gameId}` },
    ({ new: row }) => emit(gameId, row as DbGame)
  );

  const entry: GameChannelEntry = {
    channel,
    listeners: new Set(),
    ready: waitForChannelSubscribed(channel),
  };

  entry.ready.catch(() => {
    if (gameChannels.get(gameId) === entry) gameChannels.delete(gameId);
    void supabase.removeChannel(channel);
  });

  gameChannels.set(gameId, entry);
  return entry;
}

export async function subscribeToFastGame(
  gameId: string,
  onStateSync: (payload: FastStateSyncPayload) => void
) {
  // postgres_changes RLS kontrolü kullanıcının JWT'si ile yapılır; önce oturum.
  await ensureSession();

  const entry = getOrCreateGameChannel(gameId);
  entry.listeners.add(onStateSync);

  try {
    await entry.ready;
  } catch (error) {
    entry.listeners.delete(onStateSync);
    throw error;
  }

  return () => {
    entry.listeners.delete(onStateSync);
    if (entry.listeners.size === 0 && gameChannels.get(gameId) === entry) {
      gameChannels.delete(gameId);
      void supabase.removeChannel(entry.channel);
    }
  };
}

async function broadcastFastStateSync(game: DbGame) {
  const payload = { type: "state_sync", game } satisfies FastStateSyncPayload;
  const entry = gameChannels.get(game.id);

  try {
    if (entry && entry.channel.state === "joined") {
      await entry.channel.send({ type: "broadcast", event: "state_sync", payload });
      return;
    }

    // Abone kanal yoksa (ör. ana menüden katılım) REST ile gönder.
    if (entry) {
      await entry.channel.httpSend("state_sync", payload);
      return;
    }

    const temp = supabase.channel(gameTopic(game.id), {
      config: { broadcast: { self: false } },
    });
    try {
      await temp.httpSend("state_sync", payload);
    } finally {
      void supabase.removeChannel(temp);
    }
  } catch (error) {
    // Yayın başarısız olsa bile rakip postgres_changes ile güncellenir.
    dlog("broadcastFastStateSync:error", { gameId: game.id, error });
  }
}

/* ------------------------------------------------------------------ */
/* Hamle doğrulama (istemci tarafı)                                    */
/* ------------------------------------------------------------------ */

function applyRolledMove(params: {
  fen: string;
  allowedPieceType: PieceType | null;
  from: Square;
  to: Square;
  promotion?: "n" | "b" | "r" | "q";
}) {
  const { fen, allowedPieceType, from, to, promotion } = params;
  const chess = new Chess(fen);

  if (!allowedPieceType) {
    throw new Error("Bu tur için zar sonucu bulunamadı.");
  }

  if (!isMoveAllowedForRolledPiece(chess, from, to, allowedPieceType)) {
    throw new Error("Bu hamle gelen taş türüne uygun değil.");
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

  return { chess, moveResult, finalPromotion };
}

export function simulateMoveLocally(params: {
  fen: string;
  allowedPieceType: PieceType | null;
  from: Square;
  to: Square;
  promotion?: "n" | "b" | "r" | "q";
}) {
  const { chess } = applyRolledMove(params);
  return { fenAfter: chess.fen() };
}

/* ------------------------------------------------------------------ */
/* Okuma                                                               */
/* ------------------------------------------------------------------ */

export async function getGame(gameId: string): Promise<DbGame> {
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("id", gameId)
    .maybeSingle();

  if (error) {
    dlog("getGame:error", { gameId, error });
    throw new Error(error.message);
  }

  if (!data) {
    // RLS: oyuncusu olmadığın oyun görünmez.
    throw new Error("Oyun bulunamadı.");
  }

  return data as DbGame;
}

export async function getGamePlayers(gameId: string): Promise<DbGamePlayer[]> {
  const { data, error } = await supabase
    .from("game_players")
    .select("*")
    .eq("game_id", gameId)
    .order("created_at", { ascending: true });

  if (error) {
    dlog("getGamePlayers:error", { gameId, error });
    throw new Error(error.message);
  }

  return (data || []) as DbGamePlayer[];
}

export async function getMyPlayerForGame(
  gameId: string
): Promise<DbGamePlayer | null> {
  const userId = await getCurrentUserIdOrThrow();

  const { data, error } = await supabase
    .from("game_players")
    .select("*")
    .eq("game_id", gameId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    dlog("getMyPlayerForGame:error", { gameId, userId, error });
    throw new Error(error.message);
  }

  return (data as DbGamePlayer | null) ?? null;
}

/* ------------------------------------------------------------------ */
/* Yazma (RPC)                                                         */
/* ------------------------------------------------------------------ */

type GamePlayerRpcResult = {
  game: DbGame;
  player: DbGamePlayer;
  activated?: boolean;
};

export async function createLobby(): Promise<CreateLobbyResult> {
  await ensureSession();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lobbyCode = generateLobbyCode();

    const { data, error } = await supabase.rpc("create_game", {
      p_lobby_code: lobbyCode,
    });

    if (!error && data) {
      const result = data as GamePlayerRpcResult;
      dlog("createLobby:done", result);
      return { game: result.game, player: result.player };
    }

    dlog("createLobby:error", { attempt, lobbyCode, error });

    // 23505: lobi kodu çakıştı -> yeni kodla tekrar dene.
    if (error?.code !== "23505") {
      throw rpcError(error, "Lobi oluşturulamadı.");
    }
  }

  throw new Error("Lobi kodu üretilemedi. Tekrar dene.");
}

async function afterJoin(result: GamePlayerRpcResult): Promise<JoinLobbyResult> {
  if (result.activated) {
    await broadcastFastStateSync(result.game);
  }
  return { game: result.game, player: result.player };
}

export async function joinGame(gameId: string): Promise<JoinLobbyResult> {
  await ensureSession();

  const { data, error } = await supabase.rpc("join_game", {
    p_game_id: gameId,
  });

  if (error || !data) {
    dlog("joinGame:error", { gameId, error });
    throw rpcError(error, "Lobiye katılamadın.");
  }

  return afterJoin(data as GamePlayerRpcResult);
}

export async function joinLobbyByCode(code: string): Promise<JoinLobbyResult> {
  await ensureSession();

  const { data, error } = await supabase.rpc("join_game_by_code", {
    p_lobby_code: normalizeLobbyCode(code),
  });

  if (error || !data) {
    dlog("joinLobbyByCode:error", { code, error });
    throw rpcError(error, "Lobiye katılamadın.");
  }

  return afterJoin(data as GamePlayerRpcResult);
}

export async function rollForCurrentTurn(gameId: string): Promise<DbGame> {
  await ensureSession();

  const game = await getGame(gameId);

  if (game.status !== "active") {
    throw new Error("Oyun aktif değil.");
  }

  if (game.allowed_piece_type) {
    return game;
  }

  const legalTypes = getLegalPieceTypes(new Chess(game.fen));
  const rolled = pickRandom(legalTypes);

  if (!rolled) {
    throw new Error("Bu pozisyonda legal taş türü yok.");
  }

  // Sıra/oyuncu/hamle numarası kontrolleri sunucuda (save_dice_roll) yapılır.
  const { data, error } = await supabase.rpc("save_dice_roll", {
    p_game_id: gameId,
    p_move_number: game.move_count + 1,
    p_rolled_piece_type: rolled,
    p_legal_piece_types: legalTypes,
  });

  if (error || !data) {
    dlog("rollForCurrentTurn:error", { gameId, error });
    throw rpcError(error, "Zar atılamadı.");
  }

  const updated = data as DbGame;
  await broadcastFastStateSync(updated);
  return updated;
}

export async function makeMove(input: MakeMoveInput): Promise<MakeMoveResult> {
  await ensureSession();
  const { gameId, from, to, promotion } = input;

  const game = await getGame(gameId);
  if (game.status !== "active") {
    throw new Error("Oyun aktif değil.");
  }

  const { chess, moveResult, finalPromotion } = applyRolledMove({
    fen: game.fen,
    allowedPieceType: game.allowed_piece_type,
    from,
    to,
    promotion,
  });

  let resultReason: "checkmate" | "stalemate" | "draw" | null = null;
  if (chess.isCheckmate()) resultReason = "checkmate";
  else if (chess.isStalemate()) resultReason = "stalemate";
  else if (chess.isDraw()) resultReason = "draw";

  // Oyun sürüyorsa bir sonraki oyuncunun zarı hamleyle birlikte atomik yazılır.
  const nextLegalTypes = resultReason ? [] : getLegalPieceTypes(chess);
  const nextPieceType = resultReason ? null : pickRandom(nextLegalTypes);

  const { data, error } = await supabase.rpc("record_move", {
    p_game_id: gameId,
    p_move_number: game.move_count + 1,
    p_piece_type: moveResult.piece,
    p_from_square: from,
    p_to_square: to,
    p_promotion: finalPromotion ?? null,
    p_san: moveResult.san ?? null,
    p_uci: `${from}${to}${finalPromotion ?? ""}`,
    p_fen_after: chess.fen(),
    p_result_reason: resultReason,
    p_next_piece_type: nextPieceType,
    p_next_legal_piece_types: nextPieceType ? nextLegalTypes : null,
  });

  if (error || !data) {
    dlog("makeMove:error", { gameId, error });
    throw rpcError(error, "Hamle kaydedilemedi.");
  }

  const result = data as { game: DbGame; move: DbGameMove; duplicate: boolean };
  await broadcastFastStateSync(result.game);

  return { game: result.game, move: result.move };
}

export async function resignGame(gameId: string): Promise<DbGame> {
  await ensureSession();

  const { data, error } = await supabase.rpc("finish_game", {
    p_game_id: gameId,
    p_result_reason: "resign",
  });

  if (error || !data) {
    dlog("resignGame:error", { gameId, error });
    throw rpcError(error, "Pes işlemi başarısız.");
  }

  const updated = data as DbGame;
  await broadcastFastStateSync(updated);
  return updated;
}
