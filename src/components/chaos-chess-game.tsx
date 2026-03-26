import { Chess, Square } from "chess.js";

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

export const PIECE_LABELS: Record<PieceType, string> = {
  p: "Piyon",
  n: "At",
  b: "Fil",
  r: "Kale",
  q: "Vezir",
  k: "Şah",
};

export function getLegalPieceTypes(game: Chess): PieceType[] {
  const moves = game.moves({ verbose: true });
  const pieceTypes = new Set<PieceType>();

  for (const move of moves) {
    pieceTypes.add(move.piece as PieceType);
  }

  return Array.from(pieceTypes);
}

/**
 * EŞİT OLASILIK:
 * Burada taş sayısına göre weighting yok.
 * Sadece legal taş türleri unique olarak alınır
 * ve aralarından uniform random seçilir.
 *
 * Örn legal türler: [p, n, b]
 * p = 1/3, n = 1/3, b = 1/3
 */
export function rollAllowedPieceType(game: Chess): PieceType | null {
  const pieceTypes = getLegalPieceTypes(game);

  if (pieceTypes.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * pieceTypes.length);
  return pieceTypes[index];
}

export function getAllowedSquares(
  game: Chess,
  allowedPieceType: PieceType | null
): Square[] {
  if (!allowedPieceType) return [];

  const moves = game.moves({ verbose: true });
  const squares = new Set<Square>();

  for (const move of moves) {
    if (move.piece === allowedPieceType) {
      squares.add(move.from as Square);
    }
  }

  return Array.from(squares);
}

export function isMoveAllowedForRolledPiece(
  game: Chess,
  from: Square,
  to: Square,
  allowedPieceType: PieceType | null
): boolean {
  if (!allowedPieceType) return false;

  const legalMoves = game.moves({ verbose: true });

  return legalMoves.some(
    (move) =>
      move.from === from &&
      move.to === to &&
      move.piece === allowedPieceType
  );
}