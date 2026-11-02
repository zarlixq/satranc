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
 * EŞİT İHTİMAL:
 * Taş sayısına göre weighting yok.
 * Sadece legal taş türleri unique alınır.
 * Her biri tam eşit şansa sahiptir.
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

export type PromotionChoice = "n" | "b" | "r" | "q";

export function moveNeedsPromotion(
  fen: string,
  from: Square,
  to: Square,
  allowedPieceType: PieceType | null
): boolean {
  return new Chess(fen)
    .moves({ square: from, verbose: true })
    .some(
      (move) =>
        move.to === to && move.piece === allowedPieceType && !!move.promotion
    );
}

/** Zar kuralına göre hamleyi uygular; geçersizse hata fırlatır. */
export function applyChaosMove(params: {
  fen: string;
  allowedPieceType: PieceType | null;
  from: Square;
  to: Square;
  promotion?: PromotionChoice;
}) {
  const { fen, allowedPieceType, from, to, promotion } = params;

  if (!allowedPieceType) {
    throw new Error("Bu tur için zar sonucu bulunamadı.");
  }

  const chess = new Chess(fen);

  if (!isMoveAllowedForRolledPiece(chess, from, to, allowedPieceType)) {
    throw new Error("Bu hamle gelen taş türüne uygun değil.");
  }

  const finalPromotion = moveNeedsPromotion(fen, from, to, allowedPieceType)
    ? promotion ?? "q"
    : undefined;

  const move = chess.move({
    from,
    to,
    ...(finalPromotion ? { promotion: finalPromotion } : {}),
  });

  return { chess, move, finalPromotion, fenAfter: chess.fen() };
}

export type MoveOutcome = "checkmate" | "stalemate" | "draw" | null;

/** Dizilim, sıra, rok ve en passant aynıysa pozisyon aynıdır; hamle sayaçları sayılmaz. */
function positionKey(fen: string) {
  return fen.split(" ").slice(0, 4).join(" ");
}

/** Listenin son pozisyonu toplamda en az üç kez oluştu mu? */
export function isThreefoldRepetition(fens: string[]): boolean {
  if (fens.length === 0) return false;

  const last = positionKey(fens[fens.length - 1]);
  return fens.filter((fen) => positionKey(fen) === last).length >= 3;
}

/**
 * priorFens: bu hamleden önce oluşan tüm pozisyonlar (başlangıç dahil).
 * Tahta FEN'den kurulduğu için chess.js tekrarı kendisi göremez.
 */
export function determineOutcome(chess: Chess, priorFens: string[]): MoveOutcome {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isDraw()) return "draw";
  if (isThreefoldRepetition([...priorFens, chess.fen()])) return "draw";
  return null;
}

function hashString(input: string) {
  let h = 2166136261;

  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

function mulberry32(seed: number) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bu sadece ANİMASYON içindir.
 * Gerçek sonuç burada üretilmez, DB'den gelir.
 * Ama strip animasyonu iki tarafta da aynı görünsün diye deterministic üretiriz.
 */
export function buildDeterministicRollStrip(params: {
  legalTypes: PieceType[];
  finalType: PieceType;
  seedSource: string;
  stripLength?: number;
  targetIndex?: number;
}) {
  const {
    legalTypes,
    finalType,
    seedSource,
    stripLength = 28,
    targetIndex = 22,
  } = params;

  const unique = Array.from(new Set(legalTypes)).sort() as PieceType[];

  if (unique.length === 0) {
    return {
      strip: [finalType],
      targetIndex: 0,
    };
  }

  const rng = mulberry32(hashString(seedSource));
  const strip: PieceType[] = [];

  for (let i = 0; i < stripLength; i += 1) {
    const picked = unique[Math.floor(rng() * unique.length)];
    strip.push(picked);
  }

  const finalSafeIndex = Math.min(targetIndex, strip.length - 1);
  strip[finalSafeIndex] = finalType;

  return {
    strip,
    targetIndex: finalSafeIndex,
  };
}