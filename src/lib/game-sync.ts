import type { DbGame } from "@/types/db";

/**
 * Aynı durum broadcast, postgres_changes ve DB okumasından gelebilir, sıraları
 * da karışabilir. Yalnızca daha yeni sürüm uygulanır; aksi halde mevcut nesne
 * döner, böylece gereksiz render ve seçim sıfırlaması olmaz.
 */
export function pickNewerGame(prev: DbGame | null, next: DbGame): DbGame {
  if (!prev) return next;
  return next.version > prev.version ? next : prev;
}
