import { describe, expect, it } from "vitest";
import { pickNewerGame } from "@/lib/game-sync";
import type { DbGame } from "@/types/db";

function game(overrides: Partial<DbGame>): DbGame {
  return {
    id: "g",
    created_by: "u",
    lobby_code: "ABC234",
    status: "active",
    fen: "start",
    current_turn: "w",
    allowed_piece_type: "p",
    winner_user_id: null,
    result_reason: null,
    move_count: 0,
    started_at: null,
    finished_at: null,
    last_move_at: null,
    created_at: "",
    updated_at: "",
    version: 1,
    ...overrides,
  };
}

describe("pickNewerGame", () => {
  it("eski mesaj yeni durumun üzerine yazmaz", () => {
    const current = game({ version: 5, move_count: 3, fen: "new" });
    const stale = game({ version: 4, move_count: 2, fen: "old" });
    expect(pickNewerGame(current, stale)).toBe(current);
  });

  it("aynı güncelleme iki kez gelirse bir kez uygulanır", () => {
    const current = game({ version: 5, move_count: 3 });
    const duplicate = game({ version: 5, move_count: 3 });
    expect(pickNewerGame(current, duplicate)).toBe(current);
  });

  it("biten oyunu eski aktif durum geri açamaz", () => {
    const finished = game({ version: 9, move_count: 4, status: "finished" });
    const stale = game({ version: 8, move_count: 4, status: "active" });
    expect(pickNewerGame(finished, stale)).toBe(finished);
  });

  it("yeni sürüm uygulanır", () => {
    const next = game({ version: 6, move_count: 4 });
    expect(pickNewerGame(game({ version: 5 }), next)).toBe(next);
  });

  it("zar sonucu aynı hamle sayısında da uygulanır", () => {
    const next = game({ version: 3, allowed_piece_type: "n" });
    expect(pickNewerGame(game({ version: 2, allowed_piece_type: null }), next)).toBe(next);
  });
});
