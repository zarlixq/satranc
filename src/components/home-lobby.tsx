"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createLobby,
  ensureSession,
  joinLobbyByCode,
} from "@/lib/supabase/game-service";

export default function HomeLobby() {
  const router = useRouter();

  const [code, setCode] = useState("");
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("Bağlantı hazırlanıyor...");
  const [error, setError] = useState("");

  useEffect(() => {
    const boot = async () => {
      try {
        await ensureSession();
        setStatusText("Hazır");
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Oturum hazırlanamadı.";
        setError(message);
        setStatusText("Bağlantı hatası");
      } finally {
        setBooting(false);
      }
    };

    boot();
  }, []);

  const handleCreateLobby = async () => {
    try {
      setLoading(true);
      setError("");

      const { game } = await createLobby();
      router.push(`/game/${game.id}`);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Lobi oluşturulamadı.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleJoinLobby = async () => {
    try {
      if (!code.trim()) {
        setError("Önce lobi kodunu gir.");
        return;
      }

      setLoading(true);
      setError("");

      const { game } = await joinLobbyByCode(code);
      router.push(`/game/${game.id}`);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Lobiye katılınamadı.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,#1f1f23_0%,#111214_45%,#0b0c0d_100%)]">
      <div className="absolute inset-0 opacity-20">
        <div className="absolute left-[-120px] top-[-120px] h-[320px] w-[320px] rounded-full bg-[#86b94b] blur-[120px]" />
        <div className="absolute bottom-[-160px] right-[-120px] h-[360px] w-[360px] rounded-full bg-[#3b82f6] blur-[140px]" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-7xl items-center px-4 py-10 md:px-8">
        <div className="grid w-full items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="max-w-2xl">
            <p className="text-sm uppercase tracking-[0.35em] text-white/45">
              Zar + Satranç
            </p>

            <h1 className="mt-4 text-5xl font-black leading-none md:text-7xl">
              Zarlı
              <br />
              Satranç
            </h1>

            <p className="mt-6 max-w-xl text-base leading-7 text-white/70 md:text-lg">
              Klasik satrancın stratejisini, zarın kaosuyla birleştir. Lobi kur,
              kodu paylaş, rakibini içeri al ve oyunu başlat.
            </p>

            <div className="mt-8 flex flex-wrap gap-3 text-sm text-white/60">
              <span className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2">
                Gerçek zamanlı
              </span>
              <span className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2">
                Lobi kodu ile giriş
              </span>
              <span className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2">
                Zar destekli hamle sistemi
              </span>
            </div>
          </div>

          <div className="rounded-[32px] border border-white/10 bg-white/5 p-4 shadow-2xl backdrop-blur-xl md:p-6">
            <div className="rounded-[28px] border border-white/10 bg-[#17181b]/90 p-5 md:p-6">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.25em] text-white/40">
                    Ana Menü
                  </div>
                  <div className="mt-2 text-2xl font-bold text-white">
                    Lobi Sistemi
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/60">
                  {booting ? "Hazırlanıyor" : statusText}
                </div>
              </div>

              <div className="grid gap-4">
                <div className="rounded-[24px] border border-white/10 bg-[#111214] p-4">
                  <div className="text-sm font-semibold text-white">
                    Lobi Kur
                  </div>
                  <p className="mt-2 text-sm leading-6 text-white/60">
                    Yeni bir oda oluştur. Sistem sana bir lobi kodu üretir, sen
                    de rakibinle paylaşırsın.
                  </p>

                  <button
                    onClick={handleCreateLobby}
                    disabled={loading || booting}
                    className="mt-4 w-full rounded-[18px] bg-[#86b94b] px-5 py-4 text-base font-extrabold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loading ? "Oluşturuluyor..." : "Lobi Kur"}
                  </button>
                </div>

                <div className="rounded-[24px] border border-white/10 bg-[#111214] p-4">
                  <div className="text-sm font-semibold text-white">
                    Lobiye Katıl
                  </div>
                  <p className="mt-2 text-sm leading-6 text-white/60">
                    Rakibinin gönderdiği 6 haneli kodu girip direkt oyuna bağlan.
                  </p>

                  <input
                    value={code}
                    onChange={(e) =>
                      setCode(
                        e.target.value.toUpperCase().replace(/\s+/g, "")
                      )
                    }
                    placeholder="ÖRN: A7K9Q2"
                    maxLength={6}
                    className="mt-4 h-14 w-full rounded-[18px] border border-white/10 bg-[#1b1d21] px-4 text-center text-lg font-bold tracking-[0.3em] text-white outline-none placeholder:text-white/25 focus:border-[#86b94b]"
                  />

                  <button
                    onClick={handleJoinLobby}
                    disabled={loading || booting}
                    className="mt-4 w-full rounded-[18px] border border-white/10 bg-white/5 px-5 py-4 text-base font-bold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loading ? "Katılınıyor..." : "Lobiye Katıl"}
                  </button>
                </div>

                <div className="rounded-[20px] bg-black/20 px-4 py-3 text-sm leading-6 text-white/55">
                  Aynı cihazda test edeceksen gizli pencere açıp ikinci oyuncu
                  gibi katıl.
                </div>

                {error ? (
                  <div className="rounded-[20px] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {error}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}