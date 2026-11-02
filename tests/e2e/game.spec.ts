import { expect, test } from "@playwright/test";
import { Chess } from "chess.js";
import {
  anonymousEnabled,
  callRpc,
  closePlayer,
  endGame,
  expectInSync,
  newPlayer,
  playLine,
  playMove,
  rollFirst,
  startGame,
  state,
  tapSquare,
  unexpectedConsole,
  type Game,
} from "./helpers";

let game: Game | null = null;

test.afterEach(async () => {
  if (game) await endGame(game);
  game = null;
});

function recordMoveArgs(gameId: string, moveNumber: number, san: string, fen: string) {
  const chess = new Chess(fen);
  const move = chess.move(san);
  return {
    p_game_id: gameId,
    p_move_number: moveNumber,
    p_piece_type: move.piece,
    p_from_square: move.from,
    p_to_square: move.to,
    p_promotion: null,
    p_san: move.san,
    p_uci: move.from + move.to,
    p_fen_after: chess.fen(),
    p_result_reason: null,
    p_next_piece_type: chess.moves({ verbose: true })[0].piece,
    p_next_legal_piece_types: [chess.moves({ verbose: true })[0].piece],
  };
}

test("tam oyun: lobi, kodla katılma, zar, hamleler, mat, oyun sonu", async () => {
  game = await startGame();
  await playLine(game, ["f3", "e5", "g4", "Qh4#"]);

  const end = await state(game.white.page);
  expect(end.status).toBe("finished");
  expect(end.result).toBe("checkmate");
  await expect(game.white.page.getByTestId("game-over-title")).toHaveText("Kaybettin");
  await expect(game.black.page.getByTestId("game-over-title")).toHaveText("Kazandın");

  // Oyun bittikten sonra hamle gönderilemez.
  expect(end.canMove).toBe(false);
  expect(unexpectedConsole(game.white)).toEqual([]);
  expect(unexpectedConsole(game.black)).toEqual([]);

  const late = await callRpc(game.white.page, "record_move", {
    p_game_id: game.id,
    p_move_number: 5,
    p_piece_type: "p",
    p_from_square: "a2",
    p_to_square: "a3",
    p_promotion: null,
    p_san: "a3",
    p_uci: "a2a3",
    p_fen_after: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/P4P2/1PPPP2P/RNBQKBNR b KQkq - 0 3",
    p_result_reason: null,
    p_next_piece_type: "p",
    p_next_legal_piece_types: ["p"],
  });
  expect(late.ok).toBe(false);
  expect(late.body.message).toContain("Oyun aktif değil");

  // Yenilenince oyun sonu aynı gelir.
  await game.black.page.reload();
  await expect(game.black.page.getByTestId("game-over-title")).toHaveText("Kazandın");
  await expectInSync(game);
  expect(unexpectedConsole(game.black)).toEqual([]);
});

test("canlı akış: broadcast olmadan da postgres_changes rakibi anında günceller", async () => {
  game = await startGame();
  const { white, black } = game;
  await expect.poll(async () => (await state(white.page)).canRoll).toBe(true);
  await expect(black.page.getByTestId("connection-status")).toBeHidden();
  await black.page.waitForTimeout(1500);

  // Doğrudan RPC broadcast göndermez; tek canlı yol postgres_changes. Yedek okuma
  // 10 saniyede bir çalıştığı için üç adımın da 4 saniye içinde gelmesi gerekir.
  const started = await state(black.page);
  const roll = await callRpc(white.page, "save_dice_roll", {
    p_game_id: game.id,
    p_move_number: 1,
    p_rolled_piece_type: "p",
    p_legal_piece_types: ["p", "n"],
  });
  expect(roll.ok).toBe(true);
  await expect
    .poll(async () => (await state(black.page)).version, { timeout: 4_000, intervals: [100] })
    .toBeGreaterThan(started.version);

  let fen = (await state(white.page)).fen;
  for (const [index, san] of ["e4", "e5", "d4"].entries()) {
    const chess = new Chess(fen);
    const move = chess.move(san);
    const reader = move.color === "w" ? black : white;
    const writer = move.color === "w" ? white : black;
    const write = await callRpc(writer.page, "record_move", {
      p_game_id: game.id,
      p_move_number: index + 1,
      p_piece_type: "p",
      p_from_square: move.from,
      p_to_square: move.to,
      p_promotion: null,
      p_san: move.san,
      p_uci: move.from + move.to,
      p_fen_after: chess.fen(),
      p_result_reason: null,
      p_next_piece_type: "p",
      p_next_legal_piece_types: ["p"],
    });
    expect(write.ok).toBe(true);
    await expect
      .poll(async () => (await state(reader.page)).moveCount, { timeout: 4_000, intervals: [100] })
      .toBe(index + 1);
    fen = chess.fen();
  }

  await expectInSync(game);
});

test("uygulamaya dönünce (visibilitychange, focus) oyun DB'den yeniden okunur", async () => {
  game = await startGame();
  const page = game.black.page;
  // Açılıştaki ilk okumalar bitsin.
  await page.waitForTimeout(1500);

  for (const trigger of [
    () => document.dispatchEvent(new Event("visibilitychange")),
    () => window.dispatchEvent(new Event("focus")),
  ]) {
    const request = page.waitForRequest(/\/rest\/v1\/games/, { timeout: 3_000 });
    await page.evaluate(trigger);
    await request;
    await page.waitForTimeout(500);
  }
});

test("oyun ortasında sayfa yenilenince tahta, zar ve sıra aynı gelir", async () => {
  game = await startGame();
  await playLine(game, ["e4", "e5"], "Nf3");

  const before = await state(game.white.page);
  expect(before.piece).toBe("n");

  // Sırası gelen oyuncu yeniler: zar beklemeden görünür, tahta kilitli kalmaz.
  await game.white.page.reload();
  await expect(game.white.page.getByTestId("game-room")).toBeVisible();
  await expect
    .poll(async () => (await state(game!.white.page)).canMove, { timeout: 2_000 })
    .toBe(true);
  const after = await state(game.white.page);
  expect(after.fen).toBe(before.fen);
  expect(after.piece).toBe(before.piece);
  expect(after.shownPiece).toBe(before.piece);
  expect(after.turn).toBe(before.turn);

  // Diğer oyuncu da yeniler, oyun sürer ve canlı güncelleme çalışır.
  await game.black.page.reload();
  await expect(game.black.page.getByTestId("game-room")).toBeVisible();
  await expectInSync(game);
  await playMove(game, "Nf3", "Nc6");
  await playMove(game, "Nc6");
  await expectInSync(game);
});

test("offline düşen oyuncu geri gelince toparlanır, offline hamle geri alınır", async () => {
  game = await startGame();
  await playLine(game, ["e4", "e5"], "Nf3");

  // Sırası olmayan oyuncu düşer, rakip oynar.
  await game.black.context.setOffline(true);
  await expect(game.black.page.getByTestId("connection-status")).toBeVisible();
  await game.white.page.locator('[data-square="g1"]').tap();
  const whiteBefore = await state(game.white.page);
  expect(whiteBefore.canMove).toBe(true);
  await tapSquare(game.white.page, "f3");
  await expect
    .poll(async () => (await state(game!.white.page)).moveCount)
    .toBe(3);
  expect((await state(game.black.page)).moveCount).toBe(2);

  await game.black.context.setOffline(false);
  await expectInSync(game);
  await expect(game.black.page.getByTestId("connection-status")).toBeHidden({
    timeout: 30_000,
  });

  // Sırası gelen oyuncu offline'ken hamle dener: tahta geri döner, hata görünür.
  const blackState = await state(game.black.page);
  expect(blackState.turn).toBe("b");
  const blackMove = new Chess(blackState.fen)
    .moves({ verbose: true })
    .find((m) => m.piece === blackState.piece)!;

  await game.black.context.setOffline(true);
  await tapSquare(game.black.page, blackMove.from);
  await tapSquare(game.black.page, blackMove.to);
  await expect(game.black.page.getByTestId("hint")).toContainText("geri alındı", {
    timeout: 20_000,
  });
  const rolledBack = await state(game.black.page);
  expect(rolledBack.boardFen).toBe(blackState.fen);
  expect(rolledBack.moveCount).toBe(3);

  await game.black.context.setOffline(false);
  await expect(game.black.page.getByTestId("connection-status")).toBeHidden({
    timeout: 30_000,
  });
  await expect.poll(async () => (await state(game!.black.page)).canMove).toBe(true);
  await tapSquare(game.black.page, blackMove.from);
  await tapSquare(game.black.page, blackMove.to);
  await expect
    .poll(async () => (await state(game!.white.page)).moveCount)
    .toBe(4);
  await expectInSync(game);

  expect(unexpectedConsole(game.white)).toEqual([]);
  expect(unexpectedConsole(game.black, true)).toEqual([]);
});

test("çift dokunma: zar ve hamle bir kez yazılır, RPC tekrarı yazmaz", async () => {
  game = await startGame();

  await expect.poll(async () => (await state(game!.white.page)).canRoll).toBe(true);
  const beforeRoll = await state(game.white.page);
  await game.white.page.getByTestId("roll-button").dblclick();
  await expect.poll(async () => (await state(game!.white.page)).piece).not.toBe("");
  await expectInSync(game);
  expect((await state(game.white.page)).version).toBe(beforeRoll.version + 1);

  const s = await state(game.white.page);
  const move = new Chess(s.fen).moves({ verbose: true }).find((m) => m.piece === s.piece)!;
  await tapSquare(game.white.page, move.from);
  const target = game.white.page.locator(`[data-square="${move.to}"]`);
  await target.dblclick();
  await expect.poll(async () => (await state(game!.white.page)).moveCount).toBe(1);
  await expectInSync(game);
  const afterMove = await state(game.white.page);
  expect(afterMove.moveCount).toBe(1);

  // Aynı hamlenin tekrarı (yanıtı kaybolmuş istek) ikinci kez yazılmaz.
  const repeat = await callRpc(game.white.page, "record_move", {
    ...recordMoveArgs(game.id, 1, move.san, s.fen),
  });
  expect(repeat.ok).toBe(true);
  expect(repeat.body.duplicate).toBe(true);
  await game.white.page.reload();
  await expect(game.white.page.getByTestId("game-room")).toBeVisible();
  expect((await state(game.white.page)).version).toBe(afterMove.version);

  // Aynı numaraya farklı hamle reddedilir.
  const different = await callRpc(game.black.page, "record_move", {
    ...recordMoveArgs(game.id, 1, move.san, s.fen),
  });
  expect(different.ok).toBe(false);
  await expectInSync(game);
});

test("sıra kendisinde olmayan oyuncu hamle yapamaz", async () => {
  game = await startGame();
  await playLine(game, ["e4"], "e5");

  const s = await state(game.white.page);
  expect(s.turn).toBe("b");

  // Arayüz: beyaz kendi taşına ve hedefe dokunsa da hiçbir şey olmaz.
  await tapSquare(game.white.page, "g1");
  await tapSquare(game.white.page, "f3");
  expect((await state(game.white.page)).boardFen).toBe(s.fen);
  await game.white.page
    .locator('[data-square="d2"]')
    .dragTo(game.white.page.locator('[data-square="d4"]'), { force: true })
    .catch(() => undefined);
  expect((await state(game.white.page)).boardFen).toBe(s.fen);

  // RPC: arayüz atlansa da reddedilir.
  const direct = await callRpc(game.white.page, "record_move", {
    p_game_id: game.id,
    p_move_number: 2,
    p_piece_type: "p",
    p_from_square: "d2",
    p_to_square: "d4",
    p_promotion: null,
    p_san: "d4",
    p_uci: "d2d4",
    p_fen_after: "rnbqkbnr/pppppppp/8/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 1",
    p_result_reason: null,
    p_next_piece_type: "p",
    p_next_legal_piece_types: ["p"],
  });
  expect(direct.ok).toBe(false);
  expect(direct.body.message).toContain("Sıra sende değil");

  await expectInSync(game);
  expect((await state(game.black.page)).fen).toBe(s.fen);
});

test("terfi: seçim ekranı, vazgeçme, ata terfi", async () => {
  game = await startGame();
  await playLine(
    game,
    ["a4", "b5", "axb5", "a6", "bxa6", "Nf6", "a7", "Ng8"],
    "axb8=N"
  );

  await expect.poll(async () => (await state(game!.white.page)).canMove).toBe(true);
  await tapSquare(game.white.page, "a7");
  await tapSquare(game.white.page, "b8");
  await expect(game.white.page.getByTestId("promotion-picker")).toBeVisible();

  for (const piece of ["q", "r", "b", "n"]) {
    const box = await game.white.page.getByTestId(`promote-${piece}`).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }

  await game.white.page.getByTestId("promotion-cancel").tap();
  await expect(game.white.page.getByTestId("promotion-picker")).toBeHidden();
  expect((await state(game.white.page)).moveCount).toBe(8);

  await tapSquare(game.white.page, "a7");
  await tapSquare(game.white.page, "b8");
  await game.white.page.getByTestId("promote-n").tap();

  await expect.poll(async () => (await state(game!.white.page)).moveCount).toBe(9);
  await expectInSync(game);
  const placement = (await state(game.black.page)).fen.split(" ")[0];
  expect(placement.split("/")[0]).toBe("rNbqkbnr");
});

test("en passant ve rok oynanır, iki taraf aynı kalır", async () => {
  game = await startGame();
  await playLine(game, [
    "e4", "a6", "e5", "d5", "exd6", "a5", "Nf3", "a4", "Be2", "a3", "O-O",
  ]);
  const placement = (await state(game.black.page)).fen.split(" ")[0];
  expect(placement.endsWith("RNBQ1RK1")).toBe(true);
  expect(placement).toContain("3P4");
  await expectInSync(game);
});

test("üçlü tekrar oyunu beraberlikle bitirir", async () => {
  game = await startGame();
  await playLine(game, ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]);

  const end = await state(game.white.page);
  expect(end.status).toBe("finished");
  expect(end.result).toBe("draw");
  await expect(game.white.page.getByTestId("game-over-title")).toHaveText("Berabere");
  await expect(game.black.page.getByTestId("game-over-title")).toHaveText("Berabere");
  await expectInSync(game);
});

test("pes etme: onay ister, iki tarafta da doğru sonuç görünür", async () => {
  game = await startGame();
  await playLine(game, ["e4"], "e5");

  const resign = game.black.page.getByTestId("resign-button");
  await resign.tap();
  await expect(resign).toHaveText("Emin misin?");
  expect((await state(game.black.page)).status).toBe("active");
  await resign.tap();

  await expect(game.black.page.getByTestId("game-over-title")).toHaveText("Kaybettin");
  await expect(game.white.page.getByTestId("game-over-title")).toHaveText("Kazandın");
  await expect(game.black.page.getByTestId("game-over")).toContainText("Pes ettin");
  await expect(game.white.page.getByTestId("game-over")).toContainText("Rakibin pes etti");
  await expectInSync(game);
  expect((await state(game.white.page)).result).toBe("resign");
  expect((await state(game.white.page)).canMove).toBe(false);
});

test("rakip ayrılınca çevrimdışı görünür, dönünce kaybolur", async () => {
  game = await startGame();
  await rollFirst(game, "e4");

  const url = game.black.page.url();
  await game.black.page.close();
  await expect(game.white.page.getByTestId("opponent-offline")).toBeVisible({
    timeout: 45_000,
  });

  game.black.page = await game.black.context.newPage();
  await game.black.page.goto(url);
  await expect(game.white.page.getByTestId("opponent-offline")).toBeHidden({
    timeout: 45_000,
  });
  await expectInSync(game);
});

test("mobil yerleşim: tahta sığar, kareler kare, kaydırma yok, dokunma alanları 44px", async () => {
  game = await startGame();
  await rollFirst(game, "e4");
  const page = game.black.page;

  for (const [width, height] of [
    [360, 640],
    [390, 664],
    [412, 915],
    [768, 1024],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `test-results/layout-${width}x${height}.png` });

    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;
      const square = rect(document.querySelector('[data-square="e4"]'));
      const board = rect(document.querySelector('[data-testid="board"]'));
      const dice = rect(document.querySelector(".room-dice"));
      const buttons = [...document.querySelectorAll("button")]
        .filter((b) => b.getBoundingClientRect().width > 0)
        .map((b) => b.getBoundingClientRect().height);
      return {
        scrollW: root.scrollWidth,
        scrollH: root.scrollHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        square,
        board,
        dice,
        minButton: Math.min(...buttons),
      };
    });

    const label = `${width}x${height}`;
    expect(metrics.scrollW, label).toBeLessThanOrEqual(metrics.innerW);
    expect(metrics.scrollH, label).toBeLessThanOrEqual(metrics.innerH);
    expect(metrics.board!.right, label).toBeLessThanOrEqual(metrics.innerW + 0.5);
    expect(metrics.board!.bottom, label).toBeLessThanOrEqual(metrics.innerH + 0.5);
    expect(Math.abs(metrics.board!.width - metrics.board!.height), label).toBeLessThan(1);
    expect(Math.abs(metrics.square!.width - metrics.square!.height), label).toBeLessThan(1);
    expect(metrics.dice!.bottom, label).toBeLessThanOrEqual(metrics.innerH);
    expect(metrics.minButton, label).toBeGreaterThanOrEqual(44);
    if (height > width) {
      expect(metrics.board!.width, label).toBeGreaterThanOrEqual(width * 0.8);
    }
  }
});

test("paylaşılan bağlantı kodu doldurur, kopyala butonu çalışır", async () => {
  const host = await newPlayer("Pixel 7", "b");
  await host.page.goto("/");
  await host.page.getByTestId("create-lobby").tap();
  await host.page.waitForURL(/\/game\//);
  const code = (await host.page.getByTestId("lobby-code").innerText()).trim();

  await host.page.getByTestId("copy-code").tap();
  await expect(host.page.getByTestId("hint")).toContainText(/Kod/);

  await host.page.goto(`/?kod=${code}`);
  await expect(host.page.getByTestId("code-input")).toHaveValue(code);

  // iOS, 16px altındaki girişlerde sayfayı yakınlaştırır.
  const fontSize = await host.page
    .getByTestId("code-input")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);

  await host.page.setViewportSize({ width: 360, height: 640 });
  await host.page.screenshot({ path: "test-results/home-360.png", fullPage: true });
  const overflow = await host.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await closePlayer(host);
});

test("anonim giriş durumu: kapalıysa net hata, açıksa hazır", async () => {
  const fresh = await newPlayer("Pixel 7", "fresh");
  await fresh.page.goto("/");

  if (await anonymousEnabled()) {
    await expect(fresh.page.getByText("Hazır")).toBeVisible();
    await expect(fresh.page.getByTestId("lobby-error")).toHaveCount(0);
  } else {
    await expect(fresh.page.getByTestId("lobby-error")).toContainText(
      "Anonymous Sign-Ins"
    );
  }

  await closePlayer(fresh);
});
