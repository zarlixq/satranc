// Veri erişim katmanı: veritabanına giden tüm okuma ve yazmalar buradan geçer.
// Oyun kuralları burada değil, lib/supabase/game-service.ts ve lib/chaos-chess.ts içindedir.
import { supabase } from "@/lib/supabase/client";
import type {
  CreateGameResult,
  Database,
  DbGame,
  DbGameDiceRoll,
  DbGameMove,
  DbGamePlayer,
  DbPlayerStats,
  GameResultReason,
  JoinGameResult,
  PieceType,
  PromotionPiece,
  RecordMoveResult,
} from "@/types/db";

/** Postgres hata kodunu taşır (ör. 23505: unique ihlali). */
export class DbError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "DbError";
    this.code = code;
  }
}

type RpcName = keyof Database["public"]["Functions"];
type RpcArgs<N extends RpcName> = Database["public"]["Functions"][N]["Args"];
type RpcReturns<N extends RpcName> = Database["public"]["Functions"][N]["Returns"];

async function callRpc<N extends RpcName>(
  name: N,
  args: RpcArgs<N>
): Promise<RpcReturns<N>> {
  const { data, error } = await supabase.rpc(name, args as never);

  if (error) {
    throw new DbError(error.message, error.code);
  }

  return data as unknown as RpcReturns<N>;
}

export function createGame(lobbyCode: string): Promise<CreateGameResult> {
  return callRpc("create_game", { p_lobby_code: lobbyCode });
}

export function joinGame(gameId: string): Promise<JoinGameResult> {
  return callRpc("join_game", { p_game_id: gameId });
}

export function joinGameByCode(lobbyCode: string): Promise<JoinGameResult> {
  return callRpc("join_game_by_code", { p_lobby_code: lobbyCode });
}

export async function getGame(gameId: string): Promise<DbGame> {
  const { data, error } = await supabase
    .from("games")
    .select("*")
    .eq("id", gameId)
    .maybeSingle();

  if (error) {
    throw new DbError(error.message, error.code);
  }

  // RLS, oyuncusu olunmayan oyunu "yok" gibi gösterir.
  if (!data) {
    throw new DbError("Oyun bulunamadı.");
  }

  return data;
}

export async function getGamePlayers(gameId: string): Promise<DbGamePlayer[]> {
  const { data, error } = await supabase
    .from("game_players")
    .select("*")
    .eq("game_id", gameId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new DbError(error.message, error.code);
  }

  return data ?? [];
}

export async function getPlayerForGame(
  gameId: string,
  userId: string
): Promise<DbGamePlayer | null> {
  const { data, error } = await supabase
    .from("game_players")
    .select("*")
    .eq("game_id", gameId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new DbError(error.message, error.code);
  }

  return data;
}

export function saveDiceRoll(input: {
  gameId: string;
  moveNumber: number;
  rolledPieceType: PieceType;
  legalPieceTypes: PieceType[];
}): Promise<DbGame> {
  return callRpc("save_dice_roll", {
    p_game_id: input.gameId,
    p_move_number: input.moveNumber,
    p_rolled_piece_type: input.rolledPieceType,
    p_legal_piece_types: input.legalPieceTypes,
  });
}

export function saveMove(input: {
  gameId: string;
  moveNumber: number;
  pieceType: PieceType;
  from: string;
  to: string;
  promotion: PromotionPiece | null;
  san: string | null;
  uci: string | null;
  fenAfter: string;
  resultReason: GameResultReason | null;
  nextPieceType: PieceType | null;
  nextLegalPieceTypes: PieceType[] | null;
}): Promise<RecordMoveResult> {
  return callRpc("record_move", {
    p_game_id: input.gameId,
    p_move_number: input.moveNumber,
    p_piece_type: input.pieceType,
    p_from_square: input.from,
    p_to_square: input.to,
    p_promotion: input.promotion,
    p_san: input.san,
    p_uci: input.uci,
    p_fen_after: input.fenAfter,
    p_result_reason: input.resultReason,
    p_next_piece_type: input.nextPieceType,
    p_next_legal_piece_types: input.nextLegalPieceTypes,
  });
}

export function finishGame(
  gameId: string,
  resultReason: GameResultReason
): Promise<DbGame> {
  return callRpc("finish_game", {
    p_game_id: gameId,
    p_result_reason: resultReason,
  });
}

/** Replay için: hamleler move_number sırasıyla. */
export async function getGameMoves(gameId: string): Promise<DbGameMove[]> {
  const { data, error } = await supabase
    .from("game_moves")
    .select("*")
    .eq("game_id", gameId)
    .order("move_number", { ascending: true });

  if (error) {
    throw new DbError(error.message, error.code);
  }

  return data ?? [];
}

/** Replay için: zar atışları move_number sırasıyla. */
export async function getGameDiceRolls(
  gameId: string
): Promise<DbGameDiceRoll[]> {
  const { data, error } = await supabase
    .from("game_dice_rolls")
    .select("*")
    .eq("game_id", gameId)
    .order("move_number", { ascending: true });

  if (error) {
    throw new DbError(error.message, error.code);
  }

  return data ?? [];
}

/** Giriş yapan oyuncunun istatistiği. */
export async function getPlayerStats(): Promise<DbPlayerStats> {
  const rows = await callRpc("get_player_stats", {});
  return rows[0];
}
