"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import { Chessboard, type ChessboardOptions } from "react-chessboard";
import { Chess, Square } from "chess.js";
import { motion } from "framer-motion";
import {
  buildDeterministicRollStrip,
  getAllowedSquares,
  getLegalPieceTypes,
  PIECE_LABELS,
  PieceType,
} from "@/lib/chaos-chess";
import {
  DbGame,
  DbGamePlayer,
  ensureSession,
  getGame,
  getGamePlayers,
  getMyPlayerForGame,
  makeMove,
  resignGame,
  rollForCurrentTurn,
  simulateMoveLocally,
  subscribeToFastGame,
} from "@/lib/supabase/game-service";

function getStatusText(game: DbGame) {
  if (game.status === "waiting") return "Rakip bekleniyor";
  if (game.status === "finished") return "Oyun bitti";
  if (game.status === "cancelled") return "İptal edildi";

  const chess = new Chess(game.fen);

  if (chess.isCheckmate()) return "Şah mat";
  if (chess.isStalemate()) return "Pat";
  if (chess.isDraw()) return "Berabere";
  if (chess.isCheck()) {
    return `${game.current_turn === "w" ? "Beyaz" : "Siyah"} şah altında`;
  }

  return `${game.current_turn === "w" ? "Beyaz" : "Siyah"} oynuyor`;
}

function getResultText(game: DbGame) {
  if (game.status !== "finished") return null;

  switch (game.result_reason) {
    case "checkmate":
      return "Oyun şah mat ile bitti.";
    case "stalemate":
      return "Oyun pat ile bitti.";
    case "draw":
      return "Oyun berabere bitti.";
    case "resign":
      return "Rakip pes etti.";
    case "timeout":
      return "Süre dolduğu için oyun bitti.";
    case "abandon":
      return "Oyunculardan biri oyunu terk etti.";
    default:
      return "Oyun sona erdi.";
  }
}

export default function GameRoom({ gameId }: { gameId: string }) {
  const router = useRouter();

  const [game, setGame] = useState<DbGame | null>(null);
  const [players, setPlayers] = useState<DbGamePlayer[]>([]);
  const [myPlayer, setMyPlayer] = useState<DbGamePlayer | null>(null);

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copySuccess, setCopySuccess] = useState(false);
  const [realtimeConnected, setRealtimeConnected] = useState(true);

  const [optimisticFen, setOptimisticFen] = useState<string | null>(null);

  const [displayedPieceType, setDisplayedPieceType] = useState<PieceType | null>(
    null
  );
  const [isRolling, setIsRolling] = useState(false);
  const [rollStrip, setRollStrip] = useState<PieceType[]>([]);
  const [rollTargetIndex, setRollTargetIndex] = useState(0);
  const [rollAnimKey, setRollAnimKey] = useState(0);

  const rollSettleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRevealKeyRef = useRef("");

  const boardAreaRef = useRef<HTMLDivElement | null>(null);
  const [boardSize, setBoardSize] = useState(720);

  const loadAll = useCallback(async () => {
    try {
      setError("");

      await ensureSession();

      const [gameData, playersData, myData] = await Promise.all([
        getGame(gameId),
        getGamePlayers(gameId),
        getMyPlayerForGame(gameId),
      ]);

      setGame(gameData);
      setPlayers(playersData);
      setMyPlayer(myData);

      if (gameData.status === "waiting") {
        setMessage("Rakip lobiye girene kadar bekleniyor.");
      } else if (gameData.status === "finished") {
        setMessage(getResultText(gameData) ?? "Oyun bitti.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Oyun yüklenemedi.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const bootFast = async () => {
      try {
        unsubscribe = await subscribeToFastGame(gameId, (payload) => {
          if (payload.type !== "state_sync") return;
          if (payload.game.id !== gameId) return;

          setGame((prev) => {
            if (!prev) return payload.game;

            const sameOrNewer =
              payload.game.move_count >= prev.move_count ||
              payload.game.status !== prev.status ||
              payload.game.allowed_piece_type !== prev.allowed_piece_type ||
              payload.game.fen !== prev.fen;

            return sameOrNewer ? payload.game : prev;
          });

          setOptimisticFen(null);
          setSelectedSquare(null);

          if (payload.game.status !== "waiting") {
            void loadAll();
          }
        });

        if (cancelled) {
          unsubscribe?.();
          return;
        }

        setRealtimeConnected(true);
      } catch (e) {
        console.error("[Realtime]", e);

        if (cancelled) return;

        setRealtimeConnected(false);
        setMessage("Realtime bağlanamadı. Oyun kısa aralıklarla yenileniyor.");

        pollInterval = setInterval(() => {
          void loadAll();
        }, 2500);
      }
    };

    void bootFast();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [gameId, loadAll]);

  useEffect(() => {
    const element = boardAreaRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const next = Math.max(
        320,
        Math.floor(Math.min(rect.width, rect.height) - 8)
      );
      setBoardSize(next);
    };

    updateSize();

    const observer = new ResizeObserver(() => {
      updateSize();
    });

    observer.observe(element);
    window.addEventListener("resize", updateSize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    if (!copySuccess) return;

    const timeout = setTimeout(() => {
      setCopySuccess(false);
    }, 1800);

    return () => clearTimeout(timeout);
  }, [copySuccess]);

  useEffect(() => {
    if (rollSettleTimeoutRef.current) {
      clearTimeout(rollSettleTimeoutRef.current);
      rollSettleTimeoutRef.current = null;
    }

    if (!game) {
      setDisplayedPieceType(null);
      setIsRolling(false);
      setRollStrip([]);
      return;
    }

    if (game.status !== "active" || !game.allowed_piece_type) {
      setDisplayedPieceType(null);
      setIsRolling(false);
      setRollStrip([]);
      return;
    }

    const allowedPieceType = game.allowed_piece_type;

    const revealKey = [
      game.id,
      game.move_count,
      game.current_turn,
      allowedPieceType,
      game.fen,
    ].join("|");

    if (lastRevealKeyRef.current === revealKey) {
      setDisplayedPieceType(allowedPieceType);
      setIsRolling(false);
      return;
    }

    lastRevealKeyRef.current = revealKey;

    const legalTypes = getLegalPieceTypes(new Chess(game.fen));

    if (legalTypes.length <= 1) {
      setDisplayedPieceType(allowedPieceType);
      setIsRolling(false);
      setRollStrip([]);
      setMessage(`${PIECE_LABELS[allowedPieceType]} geldi.`);
      return;
    }

    const { strip, targetIndex } = buildDeterministicRollStrip({
      legalTypes,
      finalType: allowedPieceType,
      seedSource: revealKey,
      stripLength: 30,
      targetIndex: 23,
    });

    setRollStrip(strip);
    setRollTargetIndex(targetIndex);
    setRollAnimKey((prev) => prev + 1);
    setDisplayedPieceType(null);
    setIsRolling(true);

    rollSettleTimeoutRef.current = setTimeout(() => {
      setDisplayedPieceType(allowedPieceType);
      setIsRolling(false);
      setMessage(`${PIECE_LABELS[allowedPieceType]} geldi.`);
    }, 3000);

    return () => {
      if (rollSettleTimeoutRef.current) {
        clearTimeout(rollSettleTimeoutRef.current);
        rollSettleTimeoutRef.current = null;
      }
    };
  }, [game]);

  const officialChess = useMemo(() => {
    if (!game) return null;
    return new Chess(game.fen);
  }, [game]);

  const boardFen = optimisticFen ?? game?.fen ?? "start";

  const allowedSquares = useMemo(() => {
    if (!officialChess || !game?.allowed_piece_type) return [];
    return getAllowedSquares(officialChess, game.allowed_piece_type);
  }, [officialChess, game?.allowed_piece_type]);

  const legalTargetsFromSelected = useMemo(() => {
    if (!officialChess || !selectedSquare || !game?.allowed_piece_type) return [];

    return officialChess
      .moves({ square: selectedSquare, verbose: true })
      .filter((move) => move.piece === game.allowed_piece_type)
      .map((move) => move.to as Square);
  }, [officialChess, selectedSquare, game?.allowed_piece_type]);

  const legalTypesForCurrentTurn = useMemo(() => {
    if (!officialChess || game?.status !== "active") return [];
    return getLegalPieceTypes(officialChess);
  }, [officialChess, game?.status]);

  const isMyTurn = !!game && !!myPlayer && game.current_turn === myPlayer.color;

  const canInteract =
    !!game &&
    !!myPlayer &&
    game.status === "active" &&
    !!game.allowed_piece_type &&
    isMyTurn &&
    !actionLoading &&
    !isRolling;

  const canRoll =
    !!game &&
    !!myPlayer &&
    game.status === "active" &&
    !game.allowed_piece_type &&
    isMyTurn &&
    !actionLoading &&
    !isRolling;

  const statusText = game ? getStatusText(game) : "Yükleniyor";
  const resultText = game ? getResultText(game) : null;

  const opponentPlayer = useMemo(() => {
    if (!myPlayer) return null;
    return players.find((p) => p.user_id !== myPlayer.user_id) ?? null;
  }, [players, myPlayer]);

  const commitMove = useCallback(
    async (
      currentGame: DbGame,
      from: Square,
      to: Square,
      previousOptimistic: string | null
    ) => {
      try {
        const result = await makeMove({
          gameId: currentGame.id,
          from,
          to,
        });

        setGame(result.game);
        setOptimisticFen(null);

        if (result.game.status === "finished") {
          setMessage(getResultText(result.game) ?? "Oyun bitti.");
        } else {
          setMessage("Zar dönüyor...");
        }
      } catch (e) {
        setOptimisticFen(previousOptimistic);

        const msg = e instanceof Error ? e.message : "Hamle yapılamadı.";
        setError(msg);
      } finally {
        setActionLoading(false);
      }
    },
    []
  );

  const handleMove = useCallback(
    (from: Square, to: Square) => {
      if (!game || !canInteract) return false;

      const previousOptimistic = optimisticFen ?? null;

      try {
        setActionLoading(true);
        setError("");
        setSelectedSquare(null);

        const local = simulateMoveLocally({
          fen: game.fen,
          allowedPieceType: game.allowed_piece_type,
          from,
          to,
        });

        setOptimisticFen(local.fenAfter);
        setMessage("Hamle gönderiliyor...");

        void commitMove(game, from, to, previousOptimistic);
        return true;
      } catch (e) {
        setActionLoading(false);

        const msg = e instanceof Error ? e.message : "Hamle yapılamadı.";
        setError(msg);
        return false;
      }
    },
    [canInteract, commitMove, game, optimisticFen]
  );

  const handleSquareClick = useCallback<
    NonNullable<ChessboardOptions["onSquareClick"]>
  >(
    ({ square }) => {
      if (!canInteract) return;

      const clickedSquare = square as Square;

      if (selectedSquare && legalTargetsFromSelected.includes(clickedSquare)) {
        handleMove(selectedSquare, clickedSquare);
        return;
      }

      if (allowedSquares.includes(clickedSquare)) {
        setSelectedSquare(clickedSquare);
        return;
      }

      setSelectedSquare(null);
    },
    [
      allowedSquares,
      canInteract,
      handleMove,
      legalTargetsFromSelected,
      selectedSquare,
    ]
  );

  const handlePieceDrop = useCallback<
    NonNullable<ChessboardOptions["onPieceDrop"]>
  >(
    ({ sourceSquare, targetSquare }) => {
      if (!targetSquare || !canInteract) return false;

      if (!allowedSquares.includes(sourceSquare as Square)) {
        return false;
      }

      return handleMove(sourceSquare as Square, targetSquare as Square);
    },
    [allowedSquares, canInteract, handleMove]
  );

  const handleRoll = async () => {
    if (!game || !canRoll) return;

    try {
      setActionLoading(true);
      setError("");
      setMessage("Zar atılıyor...");

      const updated = await rollForCurrentTurn(game.id);
      setGame(updated);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Zar atılamadı.";
      setError(msg);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!game?.lobby_code) return;

    await navigator.clipboard.writeText(game.lobby_code);
    setCopySuccess(true);
    setMessage(`Lobi kodu kopyalandı: ${game.lobby_code}`);
  };

  const handleResign = async () => {
    if (!game) return;

    try {
      setActionLoading(true);
      setError("");

      const updated = await resignGame(game.id);
      setGame(updated);
      setOptimisticFen(null);

      await loadAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Pes işlemi başarısız.";
      setError(msg);
    } finally {
      setActionLoading(false);
    }
  };

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};

    for (const square of allowedSquares) {
      styles[square] = {
        boxShadow: "inset 0 0 0 4px rgba(132,204,22,0.95)",
      };
    }

    for (const square of legalTargetsFromSelected) {
      styles[square] = {
        background:
          "radial-gradient(circle, rgba(59,130,246,0.5) 0%, rgba(59,130,246,0.18) 38%, transparent 39%)",
      };
    }

    if (selectedSquare) {
      styles[selectedSquare] = {
        ...(styles[selectedSquare] || {}),
        boxShadow: "inset 0 0 0 4px rgba(250,204,21,0.95)",
      };
    }

    return styles;
  }, [allowedSquares, legalTargetsFromSelected, selectedSquare]);

  const boardOrientation: "white" | "black" =
    myPlayer?.color === "b" ? "black" : "white";

  const chessboardOptions = useMemo<ChessboardOptions>(
    () => ({
      position: boardFen,
      boardOrientation,
      onPieceDrop: handlePieceDrop,
      onSquareClick: handleSquareClick,
      squareStyles,
      boardStyle: {
        width: "100%",
        height: "100%",
      } as CSSProperties,
      darkSquareStyle: { backgroundColor: "#7a9b52" },
      lightSquareStyle: { backgroundColor: "#eeeed2" },
      showNotation: true,
      allowDragging: canInteract,
      animationDurationInMs: 140,
    }),
    [
      boardFen,
      boardOrientation,
      canInteract,
      handlePieceDrop,
      handleSquareClick,
      squareStyles,
    ]
  );

  const STRIP_ITEM_WIDTH = 96;
  const STRIP_VIEW_WIDTH = 288;
  const stripFinalX =
    STRIP_VIEW_WIDTH / 2 -
    (rollTargetIndex * STRIP_ITEM_WIDTH + STRIP_ITEM_WIDTH / 2);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#161512] text-white">
        <div className="rounded-3xl border border-white/10 bg-white/5 px-6 py-4 text-sm text-white/70">
          Oyun yükleniyor...
        </div>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#161512] text-white">
        <div className="rounded-3xl border border-red-500/20 bg-red-500/10 px-6 py-4 text-sm text-red-200">
          {error || "Oyun bulunamadı."}
        </div>

        <button
          onClick={() => router.push("/")}
          className="rounded-2xl bg-white px-4 py-2 text-black"
        >
          Ana Menüye Dön
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-[#161512] p-3 lg:p-4">
      <div className="grid h-full w-full grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-[28px] border border-white/8 bg-[#201e1b] p-3 lg:p-4">
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
            <div className="flex items-center justify-between rounded-2xl bg-black/10 px-4 py-3">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-white/35">
                  Rakip
                </div>
                <div className="mt-1 text-sm font-semibold text-white/90">
                  {opponentPlayer
                    ? `Bağlandı • ${
                        opponentPlayer.color === "w" ? "Beyaz" : "Siyah"
                      }`
                    : "Rakip Bekleniyor"}
                </div>
              </div>

              <div className="rounded-full border border-white/8 bg-white/5 px-4 py-2 text-sm font-semibold text-white/75">
                {game.status === "waiting" ? "Bekleniyor" : statusText}
              </div>
            </div>

            <div
              ref={boardAreaRef}
              className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-[24px] bg-[#262421]"
            >
              <div
                className="relative rounded-[10px] shadow-2xl"
                style={{
                  width: `${boardSize}px`,
                  height: `${boardSize}px`,
                  maxWidth: "100%",
                  maxHeight: "100%",
                }}
              >
                <Chessboard options={chessboardOptions} />
              </div>

              {game.status === "waiting" ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
                  <div className="rounded-[28px] border border-white/10 bg-[#161512]/90 px-8 py-7 text-center shadow-2xl">
                    <div className="text-xs uppercase tracking-[0.22em] text-white/35">
                      Lobi Açık
                    </div>
                    <div className="mt-3 text-3xl font-black tracking-[0.25em] text-white">
                      {game.lobby_code}
                    </div>
                    <div className="mt-3 text-sm text-white/60">
                      Rakip katılınca oyun aktif olur. Sırası gelen oyuncu zarı
                      atarak turu başlatır.
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-black/10 px-4 py-3">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-white/35">
                  Sen
                </div>
                <div className="mt-1 text-sm font-semibold text-white/90">
                  {myPlayer
                    ? `${myPlayer.color === "w" ? "Beyaz" : "Siyah"} oyuncu`
                    : "Oyuncu"}
                </div>
              </div>

              <div className="rounded-full border border-white/8 bg-white/5 px-4 py-2 text-sm font-semibold text-white/75">
                Kod: {game.lobby_code}
              </div>
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col gap-4 rounded-[28px] border border-white/8 bg-[#1a1816] p-4">
          <div className="grid grid-cols-2 gap-2">
            <button className="rounded-2xl bg-[#2a2825] px-4 py-3 text-sm font-semibold text-white">
              Oyun
            </button>
            <button
              onClick={() => router.push("/")}
              className="rounded-2xl bg-[#2a2825] px-4 py-3 text-sm font-semibold text-white/75 transition hover:bg-[#34312d]"
            >
              Ana Menü
            </button>
          </div>

          <div className="rounded-[24px] bg-[#24211f] p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-white/35">
              Lobi
            </div>

            <div className="mt-4 rounded-[20px] bg-[#171513] px-4 py-5 text-center">
              <div className="text-sm text-white/40">Lobi Kodu</div>
              <div className="mt-3 text-4xl font-black tracking-[0.34em] text-white">
                {game.lobby_code}
              </div>
            </div>

            <button
              onClick={handleCopyCode}
              className="mt-3 w-full rounded-[18px] bg-[#2f2c28] px-5 py-4 text-base font-bold text-white transition hover:bg-[#3a3733]"
            >
              {copySuccess ? "Kopyalandı" : "Kodu Kopyala"}
            </button>
          </div>

          <div className="rounded-[24px] bg-[#24211f] p-4">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-[0.2em] text-white/35">
                Zar Sonucu
              </div>

              {isRolling ? (
                <div className="rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200">
                  Zar dönüyor
                </div>
              ) : null}
            </div>

            {canRoll ? (
              <button
                onClick={handleRoll}
                disabled={actionLoading}
                className="mt-4 w-full rounded-[18px] bg-amber-500 px-5 py-4 text-base font-black text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {actionLoading ? "Zar Atılıyor..." : "Zarı At"}
              </button>
            ) : null}

            <div className="mt-4 rounded-[20px] border border-white/8 bg-[#151311] px-3 py-4">
              {isRolling && rollStrip.length > 0 ? (
                <>
                  <div className="relative mx-auto w-[288px] overflow-hidden rounded-[18px]">
                    <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-[96px] -translate-x-1/2 rounded-[16px] border border-amber-400/35 bg-amber-400/10 shadow-[0_0_20px_rgba(251,191,36,0.15)]" />

                    <motion.div
                      key={rollAnimKey}
                      className="flex"
                      initial={{ x: 0 }}
                      animate={{ x: stripFinalX }}
                      transition={{
                        duration: 3,
                        ease: [0.08, 0.82, 0.16, 1],
                      }}
                    >
                      {rollStrip.map((piece, index) => (
                        <div
                          key={`${piece}-${index}`}
                          className="flex h-[110px] w-[96px] shrink-0 flex-col items-center justify-center"
                        >
                          <div className="text-[11px] uppercase tracking-[0.18em] text-white/35">
                            Taş
                          </div>
                          <div className="mt-2 text-2xl font-black text-white">
                            {PIECE_LABELS[piece]}
                          </div>
                        </div>
                      ))}
                    </motion.div>
                  </div>

                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {legalTypesForCurrentTurn.map((piece) => (
                      <div
                        key={piece}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/70"
                      >
                        {PIECE_LABELS[piece]}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex min-h-[170px] flex-col items-center justify-center rounded-[18px] bg-black/10">
                  <div className="text-sm text-white/40">Bu tur</div>
                  <div className="mt-3 text-5xl font-black tracking-tight text-white">
                    {displayedPieceType
                      ? PIECE_LABELS[displayedPieceType]
                      : game.status === "waiting"
                      ? "Bekleniyor"
                      : canRoll
                      ? "Zar Bekliyor"
                      : "—"}
                  </div>

                  {legalTypesForCurrentTurn.length > 0 ? (
                    <div className="mt-4 flex flex-wrap justify-center gap-2 px-4">
                      {legalTypesForCurrentTurn.map((piece) => (
                        <div
                          key={piece}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                            displayedPieceType === piece
                              ? "border-amber-400/35 bg-amber-400/10 text-amber-100"
                              : "border-white/10 bg-white/5 text-white/70"
                          }`}
                        >
                          {PIECE_LABELS[piece]}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <div className="mt-4 rounded-2xl bg-black/15 px-4 py-3 text-sm leading-6 text-white/70">
              {game.status === "waiting"
                ? "Rakip katılınca oyun aktif olur. İlk tur zarı atarak başlar."
                : game.status === "finished"
                ? resultText || "Oyun sona erdi."
                : canRoll
                ? "Sıra sende. Zarı atarak turu başlat."
                : isRolling
                ? "Legal taş türleri arasında zar dönüyor..."
                : displayedPieceType
                ? `Sadece ${PIECE_LABELS[displayedPieceType]} ile hamle yapabilirsin.`
                : "Hamle bilgisi bekleniyor."}
            </div>
          </div>

          <div className="rounded-[24px] bg-[#24211f] p-4">
            <div className="text-xs uppercase tracking-[0.2em] text-white/35">
              Oyun Durumu
            </div>

            <div className="mt-3 text-2xl font-black text-white">
              {statusText}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-black/15 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.16em] text-white/35">
                  Sıra
                </div>
                <div className="mt-2 text-sm font-semibold text-white">
                  {game.current_turn === "w" ? "Beyaz" : "Siyah"}
                </div>
              </div>

              <div className="rounded-2xl bg-black/15 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.16em] text-white/35">
                  Oyuncular
                </div>
                <div className="mt-2 text-sm font-semibold text-white">
                  {players.length}/2
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl bg-black/15 px-4 py-3 text-sm leading-6 text-white/72">
              {error ||
                message ||
                (!realtimeConnected
                  ? "Realtime kapalı. Oyun kısa aralıklarla yenileniyor."
                  : isRolling
                  ? "Zar sonucu netleşiyor..."
                  : canRoll
                  ? "Sıra sende. Zarı atarak turu başlat."
                  : isMyTurn
                  ? "Sıra sende. Hamleni yapabilirsin."
                  : "Sıra rakipte.")}
            </div>
          </div>

          <button
            onClick={handleResign}
            disabled={actionLoading || game.status !== "active"}
            className="mt-auto rounded-[18px] border border-white/10 bg-white/5 px-5 py-4 text-base font-bold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionLoading ? "İşleniyor..." : "Pes Et"}
          </button>
        </aside>
      </div>
    </div>
  );
}