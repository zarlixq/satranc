import {
  chromium,
  devices,
  expect,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Chess, type Square } from "chess.js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];
const AUTH_KEY = `sb-${PROJECT_REF}-auth-token`;

// Anonim giriş kapalıysa önceden oluşturulmuş test kullanıcılarıyla çalışılır:
// E2E_EMAIL_A, E2E_EMAIL_B, E2E_PASSWORD. Tanımlı değilse uygulama anonim giriş yapar.
const SEEDED = {
  a: process.env.E2E_EMAIL_A,
  b: process.env.E2E_EMAIL_B,
  password: process.env.E2E_PASSWORD,
};

export type RoomState = {
  fen: string;
  boardFen: string;
  turn: string;
  piece: string;
  shownPiece: string;
  status: string;
  result: string;
  moveCount: number;
  version: number;
  rolling: boolean;
  canMove: boolean;
  canRoll: boolean;
  color: string;
};

export type Player = {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  consoleProblems: string[];
};

export type Game = { white: Player; black: Player; code: string; id: string };

async function seededSession(email: string, password: string) {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }
  );
  if (!response.ok) {
    throw new Error(`Test kullanıcısı giriş yapamadı: ${await response.text()}`);
  }
  return response.json();
}

export async function newPlayer(
  device: "iPhone 13" | "Pixel 7",
  identity: "a" | "b" | "fresh" = device === "iPhone 13" ? "a" : "b"
): Promise<Player> {
  const browser =
    device === "iPhone 13" ? await webkit.launch() : await chromium.launch();
  const context = await browser.newContext({
    ...devices[device],
    baseURL: "http://localhost:3100",
  });

  const email = identity === "fresh" ? undefined : SEEDED[identity];
  if (email && SEEDED.password) {
    const session = await seededSession(email, SEEDED.password);
    await context.addInitScript(
      ([key, value]) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      },
      [AUTH_KEY, JSON.stringify(session)]
    );
  }

  // Zarı testten yönlendirmek için: uygulama kodu değişmez, Math.random yönlendirilir.
  await context.addInitScript(() => {
    const original = Math.random.bind(Math);
    Math.random = () => {
      const forced = (window as unknown as { __rand?: number }).__rand;
      return forced ?? original();
    };
  });

  const page = await context.newPage();
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    consoleProblems.push(`pageerror: ${error.message}`);
  });

  return { page, context, browser, consoleProblems };
}

export async function closePlayer(player: Player) {
  await player.context.close();
  await player.browser.close();
}

export async function state(page: Page): Promise<RoomState> {
  return page.getByTestId("game-room").evaluate((node) => {
    const d = (node as HTMLElement).dataset;
    return {
      fen: d.fen ?? "",
      boardFen: d.boardFen ?? "",
      turn: d.turn ?? "",
      piece: d.piece ?? "",
      shownPiece: d.shownPiece ?? "",
      status: d.status ?? "",
      result: d.result ?? "",
      moveCount: Number(d.moveCount),
      version: Number(d.version),
      rolling: d.rolling === "true",
      canMove: d.canMove === "true",
      canRoll: d.canRoll === "true",
      color: d.color ?? "",
    };
  });
}

export async function startGame(): Promise<Game> {
  const white = await newPlayer("iPhone 13");
  const black = await newPlayer("Pixel 7");

  await white.page.goto("/");
  await white.page.getByTestId("create-lobby").tap();
  await white.page.waitForURL(/\/game\//);
  const code = (await white.page.getByTestId("lobby-code").innerText()).trim();
  const id = white.page.url().split("/game/")[1];

  await black.page.goto("/");
  await black.page.getByTestId("code-input").fill(code);
  await black.page.getByTestId("join-lobby").tap();
  await black.page.waitForURL(/\/game\//);

  await expect
    .poll(async () => (await state(white.page)).status, { timeout: 20_000 })
    .toBe("active");
  await expect
    .poll(async () => (await state(black.page)).status)
    .toBe("active");

  expect((await state(white.page)).color).toBe("w");
  expect((await state(black.page)).color).toBe("b");

  return { white, black, code, id };
}

export async function endGame(game: Game) {
  await closePlayer(game.white);
  await closePlayer(game.black);
}

/** İki tarafın tahtası, zarı, sırası ve sürümü birebir aynı olmalı. */
export async function expectInSync(game: Game) {
  await expect
    .poll(
      async () => {
        const [a, b] = await Promise.all([
          state(game.white.page),
          state(game.black.page),
        ]);
        const pick = (s: RoomState) => [
          s.fen,
          s.boardFen,
          s.turn,
          s.piece,
          s.shownPiece,
          s.status,
          s.result,
          s.moveCount,
          s.version,
        ];
        return JSON.stringify(pick(a)) === JSON.stringify(pick(b)) &&
          !a.rolling &&
          !b.rolling
          ? "same"
          : JSON.stringify({ a: pick(a), b: pick(b) });
      },
      { timeout: 25_000, intervals: [200, 500, 1000] }
    )
    .toBe("same");
}

function randFor(fen: string, piece: string) {
  const chess = new Chess(fen);
  const types = [...new Set(chess.moves({ verbose: true }).map((m) => m.piece))];
  const index = types.indexOf(piece as (typeof types)[number]);
  if (index < 0) throw new Error(`${piece} bu pozisyonda yasal değil: ${fen}`);
  return (index + 0.5) / types.length;
}

async function setRand(page: Page, value: number | undefined) {
  await page.evaluate((v) => {
    (window as unknown as { __rand?: number }).__rand = v;
  }, value);
}

export function moverOf(game: Game, turn: string) {
  return turn === "w" ? game.white : game.black;
}

/** İlk turun zarını beyaz atar, sonuç ilk hamleye uygun olur. */
export async function rollFirst(game: Game, firstSan: string) {
  const start = await state(game.white.page);
  const piece = new Chess(start.fen).move(firstSan).piece;
  await expect.poll(async () => (await state(game.white.page)).canRoll).toBe(true);
  await setRand(game.white.page, randFor(start.fen, piece));
  await game.white.page.getByTestId("roll-button").tap();
  await expect
    .poll(async () => (await state(game.white.page)).piece)
    .toBe(piece);
  await setRand(game.white.page, undefined);
  await expectInSync(game);
}

export async function tapSquare(page: Page, square: string) {
  await page.locator(`[data-square="${square}"]`).tap();
}

/** Kaydırma yapmadan dokun-dokun hamle yapar; bir sonraki zar nextSan'a uyar. */
export async function playMove(game: Game, san: string, nextSan?: string) {
  const before = await state(game.white.page);
  const mover = moverOf(game, before.turn);

  await expect
    .poll(async () => (await state(mover.page)).canMove, { timeout: 20_000 })
    .toBe(true);

  const chess = new Chess(before.fen);
  const move = chess.move(san);
  const after = chess.fen();

  if (nextSan) {
    const nextPiece = new Chess(after).move(nextSan).piece;
    await setRand(mover.page, randFor(after, nextPiece));
  }

  await tapSquare(mover.page, move.from);
  await tapSquare(mover.page, move.to as Square);

  await expect
    .poll(async () => (await state(mover.page)).moveCount)
    .toBe(before.moveCount + 1);
  await setRand(mover.page, undefined);
  await expectInSync(game);

  const final = await state(game.white.page);
  expect(final.fen).toBe(after);
}

/** Bir hamle dizisini baştan oynatır (ilk zar dahil). */
export async function playLine(game: Game, sans: string[], lastNext?: string) {
  const start = await state(game.white.page);
  if (start.moveCount === 0 && !start.piece) {
    await rollFirst(game, sans[0]);
  }
  for (let i = 0; i < sans.length; i += 1) {
    await playMove(game, sans[i], sans[i + 1] ?? lastNext);
  }
}

/** Sayfadaki oturumla doğrudan RPC çağırır: istemci kilitlerini aşan girişimler için. */
export async function callRpc(
  page: Page,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; body: { message?: string; duplicate?: boolean } }> {
  return page.evaluate(
    async ({ url, key, authKey, name, args }) => {
      const session = JSON.parse(localStorage.getItem(authKey) ?? "{}");
      const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      });
      return { ok: response.ok, body: await response.json() };
    },
    { url: SUPABASE_URL, key: SUPABASE_KEY, authKey: AUTH_KEY, name, args }
  );
}

/** Beklenen ağ hatalarını ayıklayıp kalan konsol sorunlarını döndürür. */
export function unexpectedConsole(player: Player, allowNetworkErrors = false) {
  return player.consoleProblems.filter((line) => {
    if (!allowNetworkErrors) return true;
    return !/Failed to (load resource|fetch)|ERR_INTERNET_DISCONNECTED|WebSocket|internet connection|network connection|Load failed|access control/i.test(
      line
    );
  });
}

export function anonymousEnabled() {
  return fetch(`${SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: SUPABASE_KEY },
  })
    .then((r) => r.json())
    .then((s) => s.external.anonymous_users as boolean);
}
