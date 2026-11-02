import { Chess, DEFAULT_POSITION, type Square } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  applyChaosMove,
  determineOutcome,
  getAllowedSquares,
  getLegalPieceTypes,
  isThreefoldRepetition,
  moveNeedsPromotion,
  rollAllowedPieceType,
  type PieceType,
} from "@/lib/chaos-chess";

// Tekrarlanabilir RNG: test sonuçları her çalıştırmada aynı olsun.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

describe("zar: oyun kilitlenmez", () => {
  it("rastgele oyunlarda her zar seçeneğinin yasal hamlesi vardır, şah altında da", () => {
    const random = rng(42);
    let checks = 0;
    let positions = 0;

    for (let g = 0; g < 12; g += 1) {
      const chess = new Chess();
      for (let ply = 0; ply < 150 && !chess.isGameOver(); ply += 1) {
        // Uygulama her pozisyonu FEN'den kurar.
        const fromFen = new Chess(chess.fen());
        const types = getLegalPieceTypes(fromFen);
        expect(types.length).toBeGreaterThan(0);
        positions += 1;

        for (const type of types) {
          expect(getAllowedSquares(fromFen, type).length).toBeGreaterThan(0);
        }

        if (fromFen.isCheck()) checks += 1;
        const moves = chess.moves({ verbose: true });
        chess.move(moves[Math.floor(random() * moves.length)]);
      }
    }

    expect(positions).toBeGreaterThan(500);
    expect(checks).toBeGreaterThan(5);
  }, 60000);

  it("şah altında zar yalnızca şahtan kurtarabilen taş türlerinden çıkar", () => {
    // e8'deki kale şah çekiyor. Piyonlar ve b1 atı kurtaramaz; a1 kalesi e-hattına
    // gelemez (b1 at engelli). Tek çıkış şahı kaçırmak.
    const fen = "4r2k/8/8/8/8/8/PP3PPP/RN2K3 w - - 0 1";
    const chess = new Chess(fen);
    expect(chess.isCheck()).toBe(true);
    expect(getLegalPieceTypes(chess)).toEqual(["k"]);
    for (let i = 0; i < 20; i += 1) {
      const rolled = rollAllowedPieceType(new Chess(fen)) as PieceType;
      expect(rolled).toBe("k");
      expect(getAllowedSquares(new Chess(fen), rolled).length).toBeGreaterThan(0);
    }
  });
});

describe("özel hamleler (FEN'den)", () => {
  it("terfi seçimi uygulanır", () => {
    const fen = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const a7 = "a7" as Square;
    const a8 = "a8" as Square;
    expect(moveNeedsPromotion(fen, a7, a8, "p")).toBe(true);
    for (const piece of ["q", "r", "b", "n"] as const) {
      const { fenAfter, finalPromotion } = applyChaosMove({
        fen,
        allowedPieceType: "p",
        from: a7,
        to: a8,
        promotion: piece,
      });
      expect(finalPromotion).toBe(piece);
      expect(fenAfter.startsWith(piece.toUpperCase())).toBe(true);
    }
  });

  it("terfi olmayan hamle terfi istemez", () => {
    expect(moveNeedsPromotion(DEFAULT_POSITION, "e2", "e4", "p")).toBe(false);
  });

  it("rok şah zarıyla yapılır, FEN doğru güncellenir", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    const short = applyChaosMove({ fen, allowedPieceType: "k", from: "e1", to: "g1" });
    expect(short.fenAfter.split(" ")[0].endsWith("R4RK1")).toBe(true);
    expect(short.fenAfter.split(" ")[2]).toBe("kq");
    const long = applyChaosMove({ fen, allowedPieceType: "k", from: "e1", to: "c1" });
    expect(long.fenAfter.split(" ")[0].endsWith("2KR3R")).toBe(true);
  });

  it("rok kale zarıyla yapılamaz", () => {
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    expect(() =>
      applyChaosMove({ fen, allowedPieceType: "r", from: "e1", to: "g1" })
    ).toThrow();
  });

  it("en passant FEN'den kurulan tahtada oynanır", () => {
    const chess = new Chess();
    for (const san of ["e4", "a6", "e5", "d5"]) chess.move(san);
    const { fenAfter, move } = applyChaosMove({
      fen: chess.fen(),
      allowedPieceType: "p",
      from: "e5",
      to: "d6",
    });
    expect(move.isEnPassant()).toBe(true);
    expect(fenAfter.split(" ")[0]).toBe(
      "rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR"
    );
  });

  it("zara uymayan taş oynanamaz", () => {
    expect(() =>
      applyChaosMove({
        fen: DEFAULT_POSITION,
        allowedPieceType: "n",
        from: "e2",
        to: "e4",
      })
    ).toThrow("uygun değil");
  });
});

describe("oyun sonu", () => {
  const playFrom = (sans: string[]) => {
    const chess = new Chess();
    const fens = [chess.fen()];
    for (const san of sans) {
      chess.move(san);
      fens.push(chess.fen());
    }
    return fens;
  };

  it("mat", () => {
    const fens = playFrom(["f3", "e5", "g4", "Qh4#"]);
    const last = new Chess(fens.at(-1));
    expect(determineOutcome(last, fens.slice(0, -1))).toBe("checkmate");
  });

  it("pat", () => {
    const chess = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
    expect(determineOutcome(chess, [])).toBe("stalemate");
  });

  it("üçlü tekrar hamle geçmişinden bulunur", () => {
    const line = ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"];
    const fens = playFrom(line);
    const last = new Chess(fens.at(-1));
    // Uygulamada tahta FEN'den kurulur, chess.js'in kendi sayacı burada işe yaramaz.
    expect(last.isThreefoldRepetition()).toBe(false);
    expect(determineOutcome(last, fens.slice(0, -1))).toBe("draw");
  });

  it("iki tekrar oyunu bitirmez", () => {
    const fens = playFrom(["Nf3", "Nf6", "Ng1", "Ng8"]);
    const last = new Chess(fens.at(-1));
    expect(determineOutcome(last, fens.slice(0, -1))).toBe(null);
  });

  it("tekrar sayımı hamle sayaçlarını yok sayar, sırayı ve rok haklarını sayar", () => {
    const a = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    const later = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 8 5";
    const latest = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 16 9";
    const noCastling = "r3k2r/8/8/8/8/8/8/R3K2R w kq - 12 7";
    const otherSide = "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 9 5";
    expect(isThreefoldRepetition([a, later, latest])).toBe(true);
    expect(isThreefoldRepetition([a, later, noCastling])).toBe(false);
    expect(isThreefoldRepetition([a, later, otherSide])).toBe(false);
  });

  it("yetersiz materyal beraberedir", () => {
    const chess = new Chess("8/8/8/4k3/8/8/4K3/8 w - - 0 1");
    expect(determineOutcome(chess, [])).toBe("draw");
  });

  it("50 hamle kuralı FEN'den çalışır", () => {
    const chess = new Chess("4k3/8/8/8/8/8/R7/4K3 w - - 100 80");
    expect(determineOutcome(chess, [])).toBe("draw");
  });
});
