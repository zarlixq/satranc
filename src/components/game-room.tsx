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
  moveNeedsPromotion,
  PIECE_LABELS,
  PieceType,
  PromotionChoice,
} from "@/lib/chaos-chess";
import { pickNewerGame } from "@/lib/game-sync";
import {
  connectGameChannel,
  type ConnectionStatus,
} from "@/lib/realtime/game-channel";
import {
  DbGame,
  DbGamePlayer,
  ensureSession,
  GameNotFoundError,
  getGame,
  getGamePlayers,
  getMyPlayerForGame,
  makeMove,
  resignGame,
  rollForCurrentTurn,
  simulateMoveLocally,
} from "@/lib/supabase/game-service";

const ROLL_DURATION_MS = 3000;
const STRIP_ITEM_WIDTH = 72;
const STRIP_VIEW_WIDTH = 216;
/** Soket sessizce ölmüş olabilir: bağlıyken bile aralıklarla DB'den okunur. */
const SAFETY_POLL_MS = 10000;
const DISCONNECTED_POLL_MS = 3000;
/** Kısa kopmalar (uygulama değiştirme, ağ geçişi) "çevrimdışı" sayılmaz. */
const OPPONENT_OFFLINE_GRACE_MS = 8000;
const RESIGN_CONFIRM_MS = 4000;

const PROMOTION_CHOICES: PromotionChoice[] = ["q", "r", "b", "n"];

function colorName(color: "w" | "b") {
  return color === "w" ? "Beyaz" : "Siyah";
}

function getStatusText(game: DbGame, myColor: "w" | "b" | null) {
  if (game.status === "waiting") return "Rakip bekleniyor";
  if (game.status === "finished") return "Oyun bitti";
  if (game.status === "cancelled") return "İptal edildi";

  const inCheck = new Chess(game.fen).isCheck();

  if (game.current_turn === myColor) {
    return inCheck ? "Sıra sende, şah altındasın" : "Sıra sende";
  }

  return inCheck
    ? `${colorName(game.current_turn)} şah altında`
    : `${colorName(game.current_turn)} oynuyor`;
}

function getResultTitle(game: DbGame, myUserId: string | null) {
  if (!game.winner_user_id) {
    return game.result_reason === "checkmate" || game.result_reason === "resign"
      ? "Oyun bitti"
      : "Berabere";
  }

  return game.winner_user_id === myUserId ? "Kazandın" : "Kaybettin";
}

function getResultText(game: DbGame, myUserId: string | null) {
  const iWon = !!myUserId && game.winner_user_id === myUserId;

  switch (game.result_reason) {
    case "checkmate":
      return iWon ? "Rakibini mat ettin." : "Mat oldun.";
    case "stalemate":
      return "Oyun pat ile bitti.";
    case "draw":
      return "Oyun berabere bitti.";
    case "resign":
      return iWon ? "Rakibin pes etti." : "Pes ettin.";
    case "timeout":
      return "Süre dolduğu için oyun bitti.";
    case "abandon":
      return "Oyunculardan biri oyunu terk etti.";
    default:
      return "Oyun sona erdi.";
  }
}

async function copyText(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // HTTP üzerinden açılan sayfalarda (ör. yerel ağ) clipboard API yoktur.
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

export default function GameRoom({ gameId }: { gameId: string }) {
  const router = useRouter();

  const [game, setGame] = useState<DbGame | null>(null);
  const [players, setPlayers] = useState<DbGamePlayer[]>([]);
  const [myPlayer, setMyPlayer] = useState<DbGamePlayer | null>(null);

  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: Square;
    to: Square;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [optimisticFen, setOptimisticFen] = useState<string | null>(null);
  const [confirmingResign, setConfirmingResign] = useState(false);
  const [endDismissed, setEndDismissed] = useState(false);

  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [presentUserIds, setPresentUserIds] = useState<string[] | null>(null);
  const [opponentOffline, setOpponentOffline] = useState(false);

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [rollAnim, setRollAnim] = useState<{
    key: string;
    strip: PieceType[];
    targetIndex: number;
  } | null>(null);

  const gameRef = useRef<DbGame | null>(null);
  const playerCountRef = useRef(0);
  const inFlightRef = useRef(false);
  const refreshRef = useRef<Promise<void> | null>(null);
  const initialRevealDoneRef = useRef(false);
  const channelRef = useRef<ReturnType<typeof connectGameChannel> | null>(null);

  const applyGame = useCallback((next: DbGame) => {
    const prev = gameRef.current;
    const merged = pickNewerGame(prev, next);
    if (merged === prev) return;

    gameRef.current = merged;
    setGame(merged);
    setError("");
    setSelectedSquare(null);
    setPendingPromotion(null);
    if (!inFlightRef.current) setOptimisticFen(null);
  }, []);

  const refresh = useCallback(() => {
    if (refreshRef.current) return refreshRef.current;

    const run = async () => {
      try {
        await ensureSession();

        const [gameData, playersData, myData] = await Promise.all([
          getGame(gameId),
          getGamePlayers(gameId),
          getMyPlayerForGame(gameId),
        ]);

        applyGame(gameData);
        playerCountRef.current = playersData.length;
        setPlayers(playersData);
        setMyPlayer(myData);
        setGone(false);
        if (!inFlightRef.current) setOptimisticFen(null);
      } catch (e) {
        if (e instanceof GameNotFoundError) {
          setGone(true);
        } else if (!gameRef.current) {
          setError(e instanceof Error ? e.message : "Oyun yüklenemedi.");
        }
        // Oyun yüklüyken geçici ağ hatası sessiz geçilir, sonraki okuma düzeltir.
      } finally {
        setLoading(false);
        refreshRef.current = null;
      }
    };

    refreshRef.current = run();
    return refreshRef.current;
  }, [applyGame, gameId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Canlı kanal: oturum hazır olduktan sonra açılır ki RLS doğru kullanıcıyla çalışsın.
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      let userId: string;
      try {
        userId = await ensureSession();
      } catch {
        return;
      }
      if (cancelled) return;

      channelRef.current = connectGameChannel(gameId, userId, {
        onGame: (next) => {
          applyGame(next);
          if (next.status !== "waiting" && playerCountRef.current < 2) {
            void refresh();
          }
        },
        onStatus: setConnection,
        onResync: () => void refresh(),
        onPresence: setPresentUserIds,
      });
    };

    void boot();

    return () => {
      cancelled = true;
      channelRef.current?.disconnect();
      channelRef.current = null;
    };
  }, [applyGame, gameId, refresh]);

  // Telefon: arka plana atılma, ekran kilidi, ağ değişimi, geri tuşu önbelleği.
  useEffect(() => {
    const resync = () => {
      channelRef.current?.ensureConnected();
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resync();
    };
    const onOnline = () => {
      channelRef.current?.reconnectNow();
      void refresh();
    };
    const onOffline = () => channelRef.current?.markOffline();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", resync);
    window.addEventListener("pageshow", resync);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", resync);
      window.removeEventListener("pageshow", resync);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refresh]);

  useEffect(() => {
    const delay =
      connection === "connected" ? SAFETY_POLL_MS : DISCONNECTED_POLL_MS;

    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      channelRef.current?.ensureConnected();
      void refresh();
    }, delay);

    return () => clearInterval(interval);
  }, [connection, refresh]);

  const opponentPlayer = useMemo(() => {
    if (!myPlayer) return null;
    return players.find((p) => p.color !== myPlayer.color) ?? null;
  }, [players, myPlayer]);

  // Kendi bağlantımız yokken rakibin durumu bilinemez, gösterge yanıltmasın.
  const opponentMissing =
    connection === "connected" &&
    game?.status === "active" &&
    !!opponentPlayer?.user_id &&
    presentUserIds !== null &&
    !presentUserIds.includes(opponentPlayer.user_id);

  useEffect(() => {
    if (!opponentMissing) {
      const clear = setTimeout(() => setOpponentOffline(false), 0);
      return () => clearTimeout(clear);
    }

    const timer = setTimeout(
      () => setOpponentOffline(true),
      OPPONENT_OFFLINE_GRACE_MS
    );
    return () => clearTimeout(timer);
  }, [opponentMissing]);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 2000);
    return () => clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!confirmingResign) return;
    const timeout = setTimeout(
      () => setConfirmingResign(false),
      RESIGN_CONFIRM_MS
    );
    return () => clearTimeout(timeout);
  }, [confirmingResign]);

  const hasGame = !!game;
  const fen = game?.fen ?? null;
  const allowedPieceType =
    game?.status === "active" ? game.allowed_piece_type : null;

  const revealKey =
    game && allowedPieceType
      ? [game.id, game.move_count, game.current_turn, allowedPieceType, fen].join("|")
      : null;

  // Zar animasyonu yalnızca canlı gelen sonuçta oynar. Sayfa yenilenince sonuç
  // beklemeden görünür, tahta da kilitli kalmaz.
  useEffect(() => {
    if (!hasGame) return;

    if (!initialRevealDoneRef.current) {
      initialRevealDoneRef.current = true;
      const settle = setTimeout(() => setRevealedKey(revealKey), 0);
      return () => clearTimeout(settle);
    }

    if (!revealKey || !allowedPieceType || !fen) return;

    const legalTypes = getLegalPieceTypes(new Chess(fen));

    if (legalTypes.length <= 1) {
      const settle = setTimeout(() => setRevealedKey(revealKey), 0);
      return () => clearTimeout(settle);
    }

    const { strip, targetIndex } = buildDeterministicRollStrip({
      legalTypes,
      finalType: allowedPieceType,
      seedSource: revealKey,
      stripLength: 30,
      targetIndex: 23,
    });

    const start = setTimeout(
      () => setRollAnim({ key: revealKey, strip, targetIndex }),
      0
    );
    const settle = setTimeout(() => setRevealedKey(revealKey), ROLL_DURATION_MS);

    return () => {
      clearTimeout(start);
      clearTimeout(settle);
    };
  }, [allowedPieceType, fen, hasGame, revealKey]);

  const isRolling = !!revealKey && revealedKey !== revealKey;
  const displayedPieceType = isRolling ? null : allowedPieceType;

  const officialChess = useMemo(() => (fen ? new Chess(fen) : null), [fen]);

  const boardFen = optimisticFen ?? fen ?? "start";

  const allowedSquares = useMemo(() => {
    if (!officialChess || !allowedPieceType) return [];
    return getAllowedSquares(officialChess, allowedPieceType);
  }, [officialChess, allowedPieceType]);

  const legalTargetsFromSelected = useMemo(() => {
    if (!officialChess || !selectedSquare || !allowedPieceType) return [];

    return officialChess
      .moves({ square: selectedSquare, verbose: true })
      .filter((move) => move.piece === allowedPieceType)
      .map((move) => move.to as Square);
  }, [officialChess, selectedSquare, allowedPieceType]);

  const legalTypesForCurrentTurn = useMemo(() => {
    if (!officialChess || game?.status !== "active") return [];
    return getLegalPieceTypes(officialChess);
  }, [officialChess, game?.status]);

  const isMyTurn = !!game && !!myPlayer && game.current_turn === myPlayer.color;

  const canInteract =
    game?.status === "active" &&
    !!allowedPieceType &&
    isMyTurn &&
    !actionLoading &&
    !isRolling;

  const canRoll =
    game?.status === "active" &&
    !game.allowed_piece_type &&
    isMyTurn &&
    !actionLoading;

  const myUserId = myPlayer?.user_id ?? null;

  const submitMove = useCallback(
    async (from: Square, to: Square, promotion?: PromotionChoice) => {
      const current = gameRef.current;
      if (!current || inFlightRef.current) return false;

      let fenAfter: string;
      try {
        fenAfter = simulateMoveLocally({
          fen: current.fen,
          allowedPieceType: current.allowed_piece_type,
          from,
          to,
          promotion,
        }).fenAfter;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Hamle yapılamadı.");
        return false;
      }

      inFlightRef.current = true;
      setActionLoading(true);
      setError("");
      setSelectedSquare(null);
      setPendingPromotion(null);
      setOptimisticFen(fenAfter);

      try {
        const result = await makeMove({ gameId: current.id, from, to, promotion });
        applyGame(result.game);
      } catch (e) {
        // Yanıt kaybolmuş olabilir: hamle yazıldıysa hata yoktur, tahta DB'ye döner.
        const fresh = await getGame(current.id).catch(() => null);
        if (fresh) applyGame(fresh);

        if (!fresh || fresh.move_count <= current.move_count) {
          setError(
            e instanceof Error
              ? `${e.message} Hamle geri alındı.`
              : "Hamle yapılamadı, geri alındı."
          );
        }
      } finally {
        inFlightRef.current = false;
        setOptimisticFen(null);
        setActionLoading(false);
      }

      return true;
    },
    [applyGame]
  );

  const handleMove = useCallback(
    (from: Square, to: Square) => {
      const current = gameRef.current;
      if (!current || !canInteract || inFlightRef.current) return false;

      if (moveNeedsPromotion(current.fen, from, to, current.allowed_piece_type)) {
        setSelectedSquare(null);
        setPendingPromotion({ from, to });
        return false;
      }

      void submitMove(from, to);
      return true;
    },
    [canInteract, submitMove]
  );

  const handleSquareClick = useCallback<
    NonNullable<ChessboardOptions["onSquareClick"]>
  >(
    ({ square }) => {
      if (!canInteract || pendingPromotion) return;

      const clickedSquare = square as Square;

      if (selectedSquare && legalTargetsFromSelected.includes(clickedSquare)) {
        handleMove(selectedSquare, clickedSquare);
        return;
      }

      if (clickedSquare !== selectedSquare && allowedSquares.includes(clickedSquare)) {
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
      pendingPromotion,
      selectedSquare,
    ]
  );

  const handlePieceDrop = useCallback<
    NonNullable<ChessboardOptions["onPieceDrop"]>
  >(
    ({ sourceSquare, targetSquare }) => {
      if (!targetSquare || !canInteract) return false;
      if (sourceSquare === targetSquare) return false;

      if (!allowedSquares.includes(sourceSquare as Square)) {
        return false;
      }

      return handleMove(sourceSquare as Square, targetSquare as Square);
    },
    [allowedSquares, canInteract, handleMove]
  );

  const handleRoll = async () => {
    if (!game || !canRoll || inFlightRef.current) return;

    inFlightRef.current = true;
    setActionLoading(true);
    setError("");

    try {
      applyGame(await rollForCurrentTurn(game.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Zar atılamadı.");
      void refresh();
    } finally {
      inFlightRef.current = false;
      setActionLoading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!game) return;

    try {
      await copyText(game.lobby_code);
      setNotice("Kod kopyalandı");
    } catch {
      setNotice(`Kod: ${game.lobby_code}`);
    }
  };

  const handleShare = async () => {
    if (!game) return;

    try {
      await navigator.share({
        title: "Zarlı Satranç",
        text: `Zarlı Satranç oynayalım. Lobi kodu: ${game.lobby_code}`,
        url: `${window.location.origin}/?kod=${game.lobby_code}`,
      });
    } catch (e) {
      // Kullanıcı paylaşım penceresini kapattıysa yapılacak bir şey yok.
      if (e instanceof Error && e.name !== "AbortError") {
        await handleCopyCode();
      }
    }
  };

  const handleResign = async () => {
    if (!game || inFlightRef.current) return;

    if (!confirmingResign) {
      setConfirmingResign(true);
      return;
    }

    setConfirmingResign(false);
    inFlightRef.current = true;
    setActionLoading(true);
    setError("");

    try {
      applyGame(await resignGame(game.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pes işlemi başarısız.");
      void refresh();
    } finally {
      inFlightRef.current = false;
      setOptimisticFen(null);
      setActionLoading(false);
    }
  };

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};

    if (canInteract) {
      for (const square of allowedSquares) {
        styles[square] = {
          boxShadow: "inset 0 0 0 4px rgba(132,204,22,0.95)",
        };
      }
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
  }, [allowedSquares, canInteract, legalTargetsFromSelected, selectedSquare]);

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

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[#161512] text-white">
        <div className="rounded-3xl border border-white/10 bg-white/5 px-6 py-4 text-sm text-white/70">
          Oyun yükleniyor...
        </div>
      </div>
    );
  }

  if (!game || gone) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-[#161512] p-6 text-center text-white">
        <div
          data-testid="room-error"
          className="rounded-3xl border border-red-500/20 bg-red-500/10 px-6 py-4 text-sm text-red-200"
        >
          {gone
            ? "Bu oyun artık yok. Süresi dolmuş olabilir ya da bu oyunun oyuncusu değilsin."
            : error || "Oyun bulunamadı."}
        </div>

        <button
          onClick={() => router.push("/")}
          className="min-h-11 rounded-2xl bg-white px-5 py-2 font-semibold text-black"
        >
          Ana Menüye Dön
        </button>
      </div>
    );
  }

  const statusText = getStatusText(game, myPlayer?.color ?? null);
  const stripFinalX = rollAnim
    ? STRIP_VIEW_WIDTH / 2 -
      (rollAnim.targetIndex * STRIP_ITEM_WIDTH + STRIP_ITEM_WIDTH / 2)
    : 0;
  const showStrip = isRolling && rollAnim?.key === revealKey;
  const canShare = typeof navigator.share === "function";
  const showGameOver = game.status === "finished" && !endDismissed;

  const hint =
    error ||
    notice ||
    (game.status === "waiting"
      ? "Kodu rakibinle paylaş. O katılınca oyun başlar."
      : game.status === "finished"
      ? getResultText(game, myUserId)
      : actionLoading
      ? "Gönderiliyor..."
      : canRoll
      ? "Sıra sende. Zarı atarak turu başlat."
      : isRolling
      ? "Zar dönüyor..."
      : isMyTurn && displayedPieceType
      ? `${PIECE_LABELS[displayedPieceType]} ile oyna: taşa, sonra hedef kareye dokun.`
      : "Sıra rakipte.");

  return (
    <div
      className="room"
      data-testid="game-room"
      data-fen={game.fen}
      data-board-fen={boardFen}
      data-turn={game.current_turn}
      data-piece={game.allowed_piece_type ?? ""}
      data-shown-piece={displayedPieceType ?? ""}
      data-status={game.status}
      data-result={game.result_reason ?? ""}
      data-move-count={game.move_count}
      data-version={game.version}
      data-rolling={isRolling}
      data-can-move={canInteract}
      data-can-roll={canRoll}
      data-color={myPlayer?.color ?? ""}
    >
      <header className="room-top">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-white" data-testid="status-text">
            {statusText}
          </div>
          <div className="truncate text-xs text-white/50">
            {myPlayer ? `Sen: ${colorName(myPlayer.color)}` : "İzleyici"}
            {" · "}
            {opponentPlayer ? `Rakip: ${colorName(opponentPlayer.color)}` : "Rakip yok"}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {connection !== "connected" ? (
            <span
              data-testid="connection-status"
              className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-xs font-semibold text-amber-200"
            >
              Bağlanıyor…
            </span>
          ) : null}
          {opponentOffline ? (
            <span
              data-testid="opponent-offline"
              className="rounded-full border border-red-400/30 bg-red-400/10 px-2.5 py-0.5 text-xs font-semibold text-red-200"
            >
              Rakip çevrimdışı
            </span>
          ) : null}
        </div>
      </header>

      <section className="room-dice">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {showStrip && rollAnim ? (
              <div
                className="relative mx-auto overflow-hidden rounded-xl"
                style={{ width: STRIP_VIEW_WIDTH }}
              >
                <div
                  className="pointer-events-none absolute inset-y-0 left-1/2 z-10 -translate-x-1/2 rounded-xl border border-amber-400/40 bg-amber-400/10"
                  style={{ width: STRIP_ITEM_WIDTH }}
                />
                <motion.div
                  key={rollAnim.key}
                  className="flex"
                  initial={{ x: 0 }}
                  animate={{ x: stripFinalX }}
                  transition={{
                    duration: ROLL_DURATION_MS / 1000,
                    ease: [0.08, 0.82, 0.16, 1],
                  }}
                >
                  {rollAnim.strip.map((piece, index) => (
                    <div
                      key={`${piece}-${index}`}
                      className="flex h-11 shrink-0 items-center justify-center text-base font-black text-white"
                      style={{ width: STRIP_ITEM_WIDTH }}
                    >
                      {PIECE_LABELS[piece]}
                    </div>
                  ))}
                </motion.div>
              </div>
            ) : canRoll ? (
              <button
                onClick={handleRoll}
                disabled={actionLoading}
                data-testid="roll-button"
                className="min-h-11 w-full rounded-xl bg-amber-500 px-4 py-2 text-base font-black text-black active:bg-amber-400 disabled:opacity-60"
              >
                {actionLoading ? "Zar Atılıyor..." : "Zarı At"}
              </button>
            ) : (
              <div className="flex min-h-11 items-center gap-2">
                <span className="text-xs uppercase tracking-wider text-white/40">
                  Zar
                </span>
                <span
                  data-testid="dice-value"
                  className="text-2xl font-black leading-none text-white"
                >
                  {displayedPieceType ? PIECE_LABELS[displayedPieceType] : "—"}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="room-wide-only mt-3 flex flex-wrap gap-2">
          {legalTypesForCurrentTurn.map((piece) => (
            <span
              key={piece}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                displayedPieceType === piece
                  ? "border-amber-400/35 bg-amber-400/10 text-amber-100"
                  : "border-white/10 bg-white/5 text-white/70"
              }`}
            >
              {PIECE_LABELS[piece]}
            </span>
          ))}
        </div>

        <p
          data-testid="hint"
          role={error ? "alert" : undefined}
          className={`mt-1 line-clamp-2 min-h-8 text-xs leading-4 ${
            error ? "text-red-300" : "text-white/65"
          }`}
        >
          {hint}
        </p>
      </section>

      <div className="room-board">
        <div className="room-board-inner" data-testid="board">
          <Chessboard options={chessboardOptions} />

          {game.status === "waiting" ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-3">
              <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-[#161512]/95 p-4 text-center">
                <div className="text-xs uppercase tracking-[0.2em] text-white/40">
                  Lobi Kodu
                </div>
                <div
                  data-testid="lobby-code"
                  className="mt-2 text-3xl font-black tracking-[0.2em] text-white"
                >
                  {game.lobby_code}
                </div>
                <div className="mt-3 grid gap-2">
                  <button
                    onClick={handleCopyCode}
                    data-testid="copy-code"
                    className="min-h-11 rounded-xl bg-white/10 px-4 font-bold text-white active:bg-white/20"
                  >
                    Kodu Kopyala
                  </button>
                  {canShare ? (
                    <button
                      onClick={handleShare}
                      data-testid="share-code"
                      className="min-h-11 rounded-xl bg-[#86b94b] px-4 font-bold text-white active:brightness-110"
                    >
                      Paylaş
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {pendingPromotion ? (
            <div
              data-testid="promotion-picker"
              className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-3"
            >
              <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-[#161512] p-4">
                <div className="text-center text-sm font-bold text-white">
                  Piyon neye terfi etsin?
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {PROMOTION_CHOICES.map((piece) => (
                    <button
                      key={piece}
                      data-testid={`promote-${piece}`}
                      onClick={() =>
                        void submitMove(
                          pendingPromotion.from,
                          pendingPromotion.to,
                          piece
                        )
                      }
                      className="min-h-12 rounded-xl bg-white/10 font-bold text-white active:bg-white/20"
                    >
                      {PIECE_LABELS[piece]}
                    </button>
                  ))}
                </div>
                <button
                  data-testid="promotion-cancel"
                  onClick={() => setPendingPromotion(null)}
                  className="mt-2 min-h-11 w-full rounded-xl text-sm font-semibold text-white/70 active:bg-white/10"
                >
                  Vazgeç
                </button>
              </div>
            </div>
          ) : null}

          {showGameOver ? (
            <div
              data-testid="game-over"
              className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-3"
            >
              <div className="w-full max-w-xs rounded-2xl border border-white/10 bg-[#161512] p-5 text-center">
                <div
                  data-testid="game-over-title"
                  className="text-3xl font-black text-white"
                >
                  {getResultTitle(game, myUserId)}
                </div>
                <div className="mt-2 text-sm text-white/70">
                  {getResultText(game, myUserId)}
                </div>
                <button
                  onClick={() => router.push("/")}
                  className="mt-4 min-h-11 w-full rounded-xl bg-[#86b94b] px-4 font-bold text-white active:brightness-110"
                >
                  Yeni Oyun
                </button>
                <button
                  onClick={() => setEndDismissed(true)}
                  className="mt-2 min-h-11 w-full rounded-xl text-sm font-semibold text-white/70 active:bg-white/10"
                >
                  Tahtayı Gör
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <footer className="room-actions">
        <button
          onClick={() => router.push("/")}
          className="min-h-11 flex-1 rounded-xl bg-white/5 px-3 text-sm font-semibold text-white/80 active:bg-white/10"
        >
          Ana Menü
        </button>
        <button
          onClick={canShare ? handleShare : handleCopyCode}
          className="min-h-11 flex-1 rounded-xl bg-white/5 px-3 text-sm font-semibold text-white/80 active:bg-white/10"
        >
          {canShare ? "Paylaş" : "Kod"}: {game.lobby_code}
        </button>
        <button
          onClick={handleResign}
          disabled={actionLoading || game.status !== "active"}
          data-testid="resign-button"
          className={`min-h-11 flex-1 rounded-xl px-3 text-sm font-bold disabled:opacity-40 ${
            confirmingResign
              ? "bg-red-500 text-white"
              : "bg-white/5 text-white/80 active:bg-white/10"
          }`}
        >
          {confirmingResign ? "Emin misin?" : "Pes Et"}
        </button>
      </footer>
    </div>
  );
}
