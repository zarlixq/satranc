// db/migrations/001_init.sql şemasının TypeScript karşılığı.

export type GameStatus = "waiting" | "active" | "finished" | "cancelled";
export type GameColor = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type PromotionPiece = "n" | "b" | "r" | "q";
export type GameResultReason =
  | "checkmate"
  | "stalemate"
  | "draw"
  | "resign"
  | "timeout"
  | "abandon";

export type DbGame = {
  id: string;
  created_by: string | null;
  lobby_code: string;
  status: GameStatus;
  fen: string;
  current_turn: GameColor;
  allowed_piece_type: PieceType | null;
  winner_user_id: string | null;
  result_reason: GameResultReason | null;
  move_count: number;
  started_at: string | null;
  finished_at: string | null;
  last_move_at: string | null;
  created_at: string;
  updated_at: string;
  /** Her güncellemede artar; eski mesajları ayıklamak için kullanılır. */
  version: number;
};

export type DbGamePlayer = {
  id: string;
  game_id: string;
  user_id: string | null;
  color: GameColor;
  is_host: boolean;
  joined_at: string;
  created_at: string;
};

export type DbGameDiceRoll = {
  id: number;
  game_id: string;
  move_number: number;
  color: GameColor;
  rolled_by: string | null;
  rolled_piece_type: PieceType;
  legal_piece_types: PieceType[];
  created_at: string;
};

export type DbGameMove = {
  id: number;
  game_id: string;
  user_id: string | null;
  move_number: number;
  color: GameColor;
  piece_type: PieceType;
  allowed_piece_type: PieceType;
  from_square: string;
  to_square: string;
  promotion: PromotionPiece | null;
  san: string | null;
  uci: string | null;
  fen_before: string;
  fen_after: string;
  created_at: string;
};

export type DbPlayerStats = {
  games_played: number;
  in_progress: number;
  wins: number;
  losses: number;
  draws: number;
};

export type CreateGameResult = {
  game: DbGame;
  player: DbGamePlayer;
};

export type JoinGameResult = CreateGameResult & {
  /** Bu katılım oyunu başlattıysa true. */
  activated: boolean;
};

export type RecordMoveResult = {
  game: DbGame;
  move: DbGameMove;
  /** Aynı hamle daha önce yazılmıştı, ikinci kez yazılmadı. */
  duplicate: boolean;
};

// Tablolar istemciden salt okunurdur; yazmalar Functions üzerinden yapılır.
type ReadOnlyTable<Row> = {
  Row: Row;
  Insert: never;
  Update: never;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      games: ReadOnlyTable<DbGame>;
      game_players: ReadOnlyTable<DbGamePlayer>;
      game_dice_rolls: ReadOnlyTable<DbGameDiceRoll>;
      game_moves: ReadOnlyTable<DbGameMove>;
    };
    Views: Record<string, never>;
    Functions: {
      create_game: {
        Args: { p_lobby_code: string };
        Returns: CreateGameResult;
      };
      join_game: {
        Args: { p_game_id: string };
        Returns: JoinGameResult;
      };
      join_game_by_code: {
        Args: { p_lobby_code: string };
        Returns: JoinGameResult;
      };
      save_dice_roll: {
        Args: {
          p_game_id: string;
          p_move_number: number;
          p_rolled_piece_type: PieceType;
          p_legal_piece_types: PieceType[];
        };
        Returns: DbGame;
      };
      record_move: {
        Args: {
          p_game_id: string;
          p_move_number: number;
          p_piece_type: PieceType;
          p_from_square: string;
          p_to_square: string;
          p_promotion: PromotionPiece | null;
          p_san: string | null;
          p_uci: string | null;
          p_fen_after: string;
          p_result_reason: GameResultReason | null;
          p_next_piece_type: PieceType | null;
          p_next_legal_piece_types: PieceType[] | null;
        };
        Returns: RecordMoveResult;
      };
      finish_game: {
        Args: { p_game_id: string; p_result_reason: GameResultReason };
        Returns: DbGame;
      };
      get_player_stats: {
        Args: Record<string, never>;
        Returns: DbPlayerStats[];
      };
    };
    Enums: {
      game_status: GameStatus;
      game_color: GameColor;
      piece_type: PieceType;
      promotion_piece: PromotionPiece;
      game_result_reason: GameResultReason;
    };
    CompositeTypes: Record<string, never>;
  };
};
