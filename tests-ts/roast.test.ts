import { beforeEach, expect, it, vi } from "vitest";
import {
  buildTurns,
  generateFortHeader,
  generateRoast,
  isRoastMessage,
  rememberMessage,
  rememberRoastMessage,
  shouldRoast,
} from "../src/bot/roast";
import type { HistoryEntry } from "../src/bot/roast";

const state = vi.hoisted(() => ({
  history: [] as HistoryEntry[],
  message_ids: [] as number[],
  last_roast: null as number | null,
}));
const tokenMock = vi.hoisted(() => vi.fn());
vi.mock("@vercel/connect", () => ({ getToken: tokenMock }));
vi.mock("../src/bot/transport", () => ({
  scopedFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
vi.mock("../src/bot/storage", () => ({ getRoastState: () => state }));
beforeEach(() => {
  state.history = [];
  state.message_ids = [];
  state.last_roast = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  tokenMock.mockReset();
  tokenMock.mockResolvedValue("app-token-secret");
});
it("groups consecutive users and preserves assistant turns", () => {
  expect(
    buildTurns([
      { role: "user", name: "one", text: "hello", ts: 1 },
      { role: "user", name: "two", text: "world", ts: 2 },
      { role: "assistant", name: "<bot>", text: "reply", ts: 3 },
      { role: "user", name: "three", text: "again", ts: 4 },
    ]),
  ).toEqual([
    { role: "user", content: "one: hello\ntwo: world" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "three: again" },
  ]);
});
it("evicts stale dialog and bounds tracked reply IDs", () => {
  rememberMessage(1, "one", "old", 1, 1);
  rememberMessage(1, "two", "new", 50000, 2);
  expect(state.history.map((entry) => entry.text)).toEqual(["new"]);
  for (let i = 0; i < 110; i++) rememberRoastMessage(1, i);
  expect(isRoastMessage(1, 0)).toBe(false);
  expect(isRoastMessage(1, 109)).toBe(true);
  expect(state.message_ids).toHaveLength(100);
});
it("enforces cooldown even with a successful random roll", () => {
  state.last_roast = 1000;
  expect(shouldRoast(1, 1010, 1, 0)).toBe(false);
  expect(shouldRoast(1, 2000, 0.2, 0.19)).toBe(true);
  expect(shouldRoast(1, 2000, 0.2, 0.2)).toBe(false);
});
it("does not duplicate the target message in generated dialog", async () => {
  rememberMessage(1, "one", "original", 100, 1);
  rememberMessage(1, "two", "reply", 101, 2, 1);
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "joke" } }] }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(await generateRoast(1, "two", "reply", 101, 2, 1)).toBe("joke");
  const payload = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(tokenMock).toHaveBeenCalledWith("grok/fortnite-collect-bot", {
    subject: { type: "app" },
  });
  expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe(
    "Bearer app-token-secret",
  );
  expect(fetcher.mock.calls[0]![1].body).not.toContain("app-token-secret");
  expect(payload.messages).toHaveLength(3);
  expect(payload.messages[2].content).toContain("original");
  expect(
    payload.messages.filter((turn: { content: string }) =>
      turn.content.includes("two: reply"),
    ),
  ).toHaveLength(0);
});
it("normalizes generated headers to one line with the initiator placeholder", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "играть\nsecond line" } }],
        }),
        { status: 200 },
      ),
    ),
  );
  expect(await generateFortHeader(1, 100)).toBe("{name} играть");
});
it("degrades optional Grok without leaking token acquisition errors", async () => {
  tokenMock.mockRejectedValue(new Error("connection failed with secret-token"));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const warn = vi.spyOn(console, "warn"),
    error = vi.spyOn(console, "error");
  expect(await generateFortHeader(1, 100)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  warn.mockRestore();
  error.mockRestore();
});
