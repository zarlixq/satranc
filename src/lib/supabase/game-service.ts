import { Chess, Square } from "chess.js";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import {
  PieceType,
  rollAllowedPieceType,
  isMoveAllowedForRolledPiece,
} from "@/lib/chaos-chess";

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

const DEBUG_GAME_SERVICE = true;

function dlog(label: string, data?: unknown) {
  if (!DEBUG_GAME_SERVICE) return;
  const now = new Date().toISOString();
  console.log(`[GAME-SERVICE ${now}] ${label}`, data ?? "");
}

function getInitialFen() {
  return "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
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
    setTimeout(() => {
      dlog("broadcastFastStateSync:cleanup", { gameId: game.id });
      void supabase.removeChannel(channel);
    }, 300);
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

  let createdGame: DbGame | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lobbyCode = generateLobbyCode();
    dlog("createLobby:attempt", { attempt, lobbyCode });

    const { data, error } = await supabase
      .from("games")
      .insert({
        created_by: userId,
        lobby_code: lobbyCode,
        status: "waiting",
        fen: getInitialFen(),
        current_turn: "w",
        allowed_piece_type: null,
        move_count: 0,
      })
      .select()
      .single();

    if (!error && data) {
      createdGame = data as DbGame;
      dlog("createLobby:game-created", createdGame);
      break;
    }

    dlog("createLobby:insert-error", error);

    if (error?.code !== "23505") {
      throw new Error(error?.message || "Lobi oluşturulamadı.");
    }
  }

  if (!createdGame) {
    throw new Error("Lobi kodu üretilemedi. Tekrar dene.");
  }

  const { data: player, error: playerError } = await supabase
    .from("game_players")
    .insert({
      game_id: createdGame.id,
      user_id: userId,
      color: "w",
      is_host: true,
    })
    .select()
    .single();

  if (playerError || !player) {
    dlog("createLobby:host-player-error", playerError);
    throw new Error(playerError?.message || "Host oyuncu eklenemedi.");
  }

  dlog("createLobby:done", {
    game: createdGame,
    player,
  });

  return {
    game: createdGame,
    player: player as DbGamePlayer,
  };
}

export async function getGame(gameId: string): Promise<DbGame> {
  dlog("getGame:start", { gameId });

  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("id", gameId)
    .single();

  if (error || !data) {
    dlog("getGame:error", { gameId, error });
    throw new Error(error?.message || "Oyun bulunamadı.");
  }

  dlog("getGame:done", {
    gameId,
    status: data.status,
    moveCount: data.move_count,
    currentTurn: data.current_turn,
    allowedPieceType: data.allowed_piece_type,
  });

  return data as DbGame;
}

export async function getGameByCode(code: string): Promise<DbGame> {
  const normalized = normalizeLobbyCode(code);
  dlog("getGameByCode:start", { code, normalized });

  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("lobby_code", normalized)
    .single();

  if (error || !data) {
    dlog("getGameByCode:error", { normalized, error });
    throw new Error("Bu kodla bir lobi bulunamadı.");
  }

  dlog("getGameByCode:done", {
    id: data.id,
    status: data.status,
    lobbyCode: data.lobby_code,
  });

  return data as DbGame;
}

export async function getGamePlayers(gameId: string): Promise<DbGamePlayer[]> {
  dlog("getGamePlayers:start", { gameId });

  const { data, error } = await supabase
    .from("game_players")
    .select("*")
    .eq("game_id", gameId)
    .order("created_at", { ascending: true });

  if (error) {
    dlog("getGamePlayers:error", { gameId, error });
    throw new Error(error.message);
  }

  dlog("getGamePlayers:done", {
    gameId,
    count: data?.length ?? 0,
    players: data,
  });

  return (data || []) as DbGamePlayer[];
}

export async function getMyPlayerForGame(
  gameId: string
): Promise<DbGamePlayer | null> {
  const userId = await getCurrentUserIdOrThrow();
  dlog("getMyPlayerForGame:start", { gameId, userId });

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

  dlog("getMyPlayerForGame:done", {
    gameId,
    userId,
    player: data ?? null,
  });

  return (data as DbGamePlayer | null) ?? null;
}

export async function joinGame(gameId: string): Promise<JoinLobbyResult> {
  const userId = await getCurrentUserIdOrThrow();
  dlog("joinGame:start", { gameId, userId });

  const existingPlayer = await getMyPlayerForGame(gameId);
  if (existingPlayer) {
    dlog("joinGame:existing-player", existingPlayer);
    const game = await getGame(gameId);
    return { game, player: existingPlayer };
  }

  const game = await getGame(gameId);
  dlog("joinGame:game", {
    id: game.id,
    status: game.status,
    lobbyCode: game.lobby_code,
  });

  if (game.status !== "waiting") {
    throw new Error("Bu lobi artık katılıma açık değil.");
  }

  const players = await getGamePlayers(gameId);
  dlog("joinGame:players-before", players);

  if (players.length >= 2) {
    throw new Error("Lobi dolu.");
  }

  const whiteTaken = players.some((p) => p.color === "w");
  const blackTaken = players.some((p) => p.color === "b");

  let myColor: GameColor | null = null;

  if (!whiteTaken) myColor = "w";
  else if (!blackTaken) myColor = "b";

  if (!myColor) {
    throw new Error("Boş renk bulunamadı.");
  }

  const { data: player, error: playerError } = await supabase
    .from("game_players")
    .insert({
      game_id: gameId,
      user_id: userId,
      color: myColor,
      is_host: false,
    })
    .select()
    .single();

  if (playerError || !player) {
    dlog("joinGame:player-insert-error", playerError);
    throw new Error(playerError?.message || "Lobiye katılamadın.");
  }

  dlog("joinGame:player-inserted", player);

  const updatedPlayersCount = players.length + 1;

  if (updatedPlayersCount === 2) {
    dlog("joinGame:activating-game", { gameId });

    const { data: updatedGame, error: updateError } = await supabase
      .from("games")
      .update({
        status: "active",
        started_at: new Date().toISOString(),
        current_turn: "w",
        allowed_piece_type: null,
      })
      .eq("id", gameId)
      .select()
      .single();

    if (updateError || !updatedGame) {
      dlog("joinGame:activate-error", updateError);
      throw new Error(updateError?.message || "Oyun başlatılamadı.");
    }

    dlog("joinGame:game-activated", updatedGame);

    await broadcastFastStateSync(updatedGame as DbGame);

    return {
      game: updatedGame as DbGame,
      player: player as DbGamePlayer,
    };
  }

  dlog("joinGame:done-waiting", {
    gameId,
    updatedPlayersCount,
    player,
  });

  return {
    game,
    player: player as DbGamePlayer,
  };
}

export async function joinLobbyByCode(code: string): Promise<JoinLobbyResult> {
  dlog("joinLobbyByCode:start", { code });
  const game = await getGameByCode(code);
  return joinGame(game.id);
}

export async function rollForCurrentTurn(gameId: string): Promise<DbGame> {
  dlog("rollForCurrentTurn:start", { gameId });

  const game = await getGame(gameId);

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

  const { data, error } = await supabase
    .from("games")
    .update({
      allowed_piece_type: rolled,
      last_move_at: new Date().toISOString(),
    })
    .eq("id", gameId)
    .is("allowed_piece_type", null)
    .select()
    .single();

  if (error || !data) {
    dlog("rollForCurrentTurn:update-error", { gameId, error });
    throw new Error(error?.message || "Zar atılamadı.");
  }

  dlog("rollForCurrentTurn:updated", data);

  await broadcastFastStateSync(data as DbGame);

  return data as DbGame;
}

export async function makeMove(input: MakeMoveInput): Promise<MakeMoveResult> {
  const userId = await getCurrentUserIdOrThrow();
  const { gameId, from, to, promotion } = input;

  dlog("makeMove:start", { gameId, userId, from, to, promotion });

  const game = await getGame(gameId);
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

  let nextStatus: GameStatus = "active";
  let nextAllowedPieceType: PieceType | null = null;
  let winnerUserId: string | null = null;
  let resultReason: DbGame["result_reason"] = null;
  let finishedAt: string | null = null;

  if (chess.isCheckmate()) {
    nextStatus = "finished";
    winnerUserId = userId;
    resultReason = "checkmate";
    finishedAt = new Date().toISOString();
  } else if (chess.isStalemate()) {
    nextStatus = "finished";
    resultReason = "stalemate";
    finishedAt = new Date().toISOString();
  } else if (chess.isDraw()) {
    nextStatus = "finished";
    resultReason = "draw";
    finishedAt = new Date().toISOString();
  } else {
    nextAllowedPieceType = rollAllowedPieceType(chess);
  }

  const { data: updatedGame, error: updateError } = await supabase
    .from("games")
    .update({
      fen: fenAfter,
      current_turn: chess.turn() as GameColor,
      allowed_piece_type: nextAllowedPieceType,
      move_count: moveNumber,
      last_move_at: new Date().toISOString(),
      status: nextStatus,
      winner_user_id: winnerUserId,
      result_reason: resultReason,
      finished_at: finishedAt,
    })
    .eq("id", gameId)
    .select()
    .single();

  if (updateError || !updatedGame) {
    dlog("makeMove:game-update-error", { gameId, updateError });
    throw new Error(updateError?.message || "Oyun güncellenemedi.");
  }

  dlog("makeMove:game-updated", updatedGame);

  const { data: insertedMove, error: moveError } = await supabase
    .from("game_moves")
    .insert({
      game_id: gameId,
      user_id: userId,
      move_number: moveNumber,
      color: myPlayer.color,
      piece_type: moveResult.piece,
      allowed_piece_type: game.allowed_piece_type,
      from_square: from,
      to_square: to,
      promotion: finalPromotion ?? null,
      san: moveResult.san ?? null,
      uci: `${from}${to}${finalPromotion ?? ""}`,
      fen_before: game.fen,
      fen_after: fenAfter,
    })
    .select()
    .single();

  if (moveError || !insertedMove) {
    dlog("makeMove:move-insert-error", { gameId, moveError });
    throw new Error(moveError?.message || "Hamle kaydı yazılamadı.");
  }

  dlog("makeMove:move-inserted", insertedMove);

  await broadcastFastStateSync(updatedGame as DbGame);

  dlog("makeMove:done", {
    gameId,
    moveCount: updatedGame.move_count,
    allowedPieceType: updatedGame.allowed_piece_type,
    status: updatedGame.status,
  });

  return {
    game: updatedGame as DbGame,
    move: insertedMove as DbGameMove,
  };
}

export async function resignGame(gameId: string): Promise<DbGame> {
  const userId = await getCurrentUserIdOrThrow();
  dlog("resignGame:start", { gameId, userId });

  const game = await getGame(gameId);
  if (game.status !== "active") {
    throw new Error("Sadece aktif oyunda pes edebilirsin.");
  }

  const myPlayer = await getMyPlayerForGame(gameId);
  if (!myPlayer) {
    throw new Error("Bu oyunun oyuncusu değilsin.");
  }

  const players = await getGamePlayers(gameId);
  const opponent = players.find((p) => p.user_id !== userId);

  const { data, error } = await supabase
    .from("games")
    .update({
      status: "finished",
      winner_user_id: opponent?.user_id ?? null,
      result_reason: "resign",
      finished_at: new Date().toISOString(),
      allowed_piece_type: null,
    })
    .eq("id", gameId)
    .select()
    .single();

  if (error || !data) {
    dlog("resignGame:error", { gameId, error });
    throw new Error(error?.message || "Pes işlemi başarısız.");
  }

  dlog("resignGame:updated", data);

  await broadcastFastStateSync(data as DbGame);

  return data as DbGame;
}