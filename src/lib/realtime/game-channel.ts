import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import type { DbGame } from "@/types/db";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

type Handlers = {
  /** Broadcast veya postgres_changes ile gelen oyun durumu. */
  onGame: (game: DbGame) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Kanal (yeniden) bağlandı: aradaki kaçan güncellemeler için DB'den oku. */
  onResync: () => void;
  /** O an kanalda olan kullanıcılar. */
  onPresence: (userIds: string[]) => void;
};

const MAX_RETRY_DELAY_MS = 15000;

function topicName(gameId: string) {
  return `game-fast-${gameId}`;
}

// supabase.channel() aynı topic için var olan kanalı döndürür. Kapanmakta olan
// bir kanala yeniden abone olunamayacağı için önce kapanışı beklemek gerekir.
const teardowns = new Map<string, Promise<unknown>>();

export function connectGameChannel(
  gameId: string,
  userId: string,
  handlers: Handlers
) {
  const topic = topicName(gameId);
  let stopped = false;
  let channel: RealtimeChannel | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let opening = false;

  const close = async () => {
    const current = channel;
    channel = null;
    if (!current) return;

    const removal = supabase.removeChannel(current).catch(() => undefined);
    teardowns.set(topic, removal);
    await removal;
    if (teardowns.get(topic) === removal) teardowns.delete(topic);
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;

    handlers.onStatus("reconnecting");
    const delay = Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
    attempt += 1;

    retryTimer = setTimeout(() => {
      retryTimer = null;
      void reopen();
    }, delay);
  };

  const open = async () => {
    await teardowns.get(topic);
    if (stopped || channel) return;

    const next = supabase.channel(topic, {
      config: {
        broadcast: { self: false },
        presence: { key: userId },
      },
    });
    channel = next;

    next
      .on("broadcast", { event: "state_sync" }, ({ payload }) => {
        const game = (payload as { game?: DbGame }).game;
        if (game?.id === gameId) handlers.onGame(game);
      })
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "games",
          filter: `id=eq.${gameId}`,
        },
        ({ new: row }) => handlers.onGame(row as DbGame)
      )
      .on("presence", { event: "sync" }, () => {
        handlers.onPresence(Object.keys(next.presenceState()));
      })
      .subscribe((status) => {
        if (stopped || next !== channel) return;

        if (status === "SUBSCRIBED") {
          attempt = 0;
          handlers.onStatus("connected");
          handlers.onResync();
          void next.track({ online: true }).catch(() => undefined);
          return;
        }

        scheduleRetry();
      });
  };

  const reopen = async () => {
    if (stopped || opening) return;
    opening = true;
    try {
      await close();
      await open();
    } finally {
      opening = false;
    }
  };

  handlers.onStatus("connecting");
  void open();

  return {
    /** Kanal bağlı değilse hemen yeniden bağlanır. */
    ensureConnected() {
      if (stopped || opening || retryTimer) return;
      if (channel?.state === "joined") return;
      if (channel?.state === "joining") return;
      handlers.onStatus("reconnecting");
      void reopen();
    },
    /** Ağ koptu: göstergeyi hemen güncelle. */
    markOffline() {
      if (!stopped) handlers.onStatus("reconnecting");
    },
    /** Ağ geri geldi: eski soket ölü olabilir, kanalı temiz aç. */
    reconnectNow() {
      if (stopped) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      attempt = 0;
      handlers.onStatus("reconnecting");
      void reopen();
    },
    disconnect() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      void close();
    },
  };
}

/** Yalnızca açık kanaldan gönderir; bağlı değilse postgres_changes ve DB okuması telafi eder. */
export async function broadcastGameState(game: DbGame) {
  const topic = `realtime:${topicName(game.id)}`;
  const live = supabase
    .getChannels()
    .find((item) => item.topic === topic && item.state === "joined");

  if (!live) return;

  try {
    await live.send({
      type: "broadcast",
      event: "state_sync",
      payload: { game },
    });
  } catch {
    // Mesaj kaybı oyunu bozmaz: karşı taraf postgres_changes ile de güncellenir.
  }
}
