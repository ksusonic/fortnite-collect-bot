import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  enqueue: vi.fn(),
  recover: vi.fn(),
  cleanup: vi.fn(),
  sessions: vi.fn(),
  chats: vi.fn(),
  active: vi.fn(),
  fetch: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("../src/bot/storage", () => ({
  raw: mocks.raw,
  invocation: async (_chat: unknown, fn: () => unknown) => fn(),
  advisoryLock: mocks.lock,
}));
vi.mock("../src/bot/runtime", () => ({
  enqueue: mocks.enqueue,
  recoverPending: mocks.recover,
  createBot: () => ({}),
}));
vi.mock("../src/bot/db", () => ({
  cleanup_old_snapshots: mocks.cleanup,
  load_active_sessions: mocks.sessions,
  get_chats_with_epic_links: mocks.chats,
  get_active_chat_ids: mocks.active,
}));
vi.mock("../src/bot/status", async (original) => ({
  ...(await original<typeof import("../src/bot/status")>()),
  fetchStatus: mocks.fetch,
}));
import { runJob, statusCheck } from "../src/bot/jobs";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.raw.mockImplementation(async (sql: string) => ({
    rows: sql.includes("to_regclass")
      ? [{ table_name: null }]
      : sql.includes("SELECT status")
        ? [{ status: "pending" }]
        : [],
    rowCount: 0,
  }));
  mocks.lock.mockImplementation(async (_name: string, fn: () => unknown) =>
    fn(),
  );
  mocks.sessions.mockResolvedValue([]);
  mocks.chats.mockResolvedValue([]);
  mocks.active.mockResolvedValue([]);
});
describe("durable job orchestration", () => {
  it("skips an overlapping lock without enqueueing", async () => {
    mocks.lock.mockResolvedValue(undefined);
    expect(await runJob("expiry")).toEqual({ ok: true, skipped: "overlap" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("does not repeat a completed job tick", async () => {
    mocks.raw.mockImplementation(async (sql: string) => ({
      rows: sql.includes("SELECT status") ? [{ status: "complete" }] : [],
    }));
    expect(await runJob("cleanup")).toEqual({ ok: true, skipped: "duplicate" });
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it("gates cleanup on a verified import", async () => {
    expect(await runJob("cleanup")).toEqual({
      ok: true,
      skipped: "import not verified",
    });
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it("enqueues expiry with the original timestamp and Moscow deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T20:00:00Z"));
    mocks.sessions.mockResolvedValue([{ chat_id: -100, message_id: 9 }]);
    await runJob("expiry");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("expiry:-100:9:"),
      "expiry",
      -100,
      { now: Date.parse("2026-10-02T20:00:00Z") / 1000, past_deadline: true },
    );
    expect(mocks.recover).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
  it("runs weekly only Friday at 21:00 Moscow", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-10-02T18:05:00Z"));
    mocks.chats.mockResolvedValue([-100]);
    await runJob("weekly");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "weekly:2026-10-02:-100",
      "weekly",
      -100,
      { now: Date.parse("2026-10-02T18:05:00Z") / 1000 },
    );
    mocks.enqueue.mockClear();
    now.mockReturnValue(Date.parse("2026-10-02T19:00:00Z"));
    await runJob("weekly");
    expect(mocks.enqueue).not.toHaveBeenCalledWith(
      expect.anything(),
      "weekly",
      expect.anything(),
      expect.anything(),
    );
    vi.restoreAllMocks();
  });
  it("reuses the first job timestamp when a tick retries", async () => {
    const original = Date.parse("2026-10-02T18:05:03Z") / 1000;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T18:09:59Z"));
    mocks.raw.mockImplementation(async (sql: string) => ({
      rows: sql.includes("SELECT status")
        ? [{ status: "failed", payload: { name: "weekly", now: original } }]
        : [],
    }));
    mocks.chats.mockResolvedValue([-100]);
    await runJob("weekly");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "weekly:2026-10-02:-100",
      "weekly",
      -100,
      { now: original },
    );
    vi.restoreAllMocks();
  });
  it("recovers legacy job time from the stored tick", async () => {
    const retry = Date.parse("2026-10-02T18:09:59Z");
    vi.spyOn(Date, "now").mockReturnValue(retry);
    mocks.raw.mockImplementation(async (sql: string) => ({
      rows: sql.includes("SELECT status")
        ? [{ status: "failed", payload: { name: "weekly" } }]
        : [],
    }));
    mocks.chats.mockResolvedValue([-100]);
    await runJob("weekly");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "weekly:2026-10-02:-100",
      "weekly",
      -100,
      { now: Math.floor(retry / 1000 / 300) * 300 },
    );
    vi.restoreAllMocks();
  });
  it("commits alert enqueueing atomically with durable status state", async () => {
    mocks.fetch.mockResolvedValue({
      indicator: "major",
      description: "Login down",
      incidents: [],
    });
    mocks.active.mockResolvedValue([-100]);
    await statusCheck(Date.parse("2026-10-02T18:00:00Z"));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("status:"),
      "status",
      -100,
      { text: expect.stringContaining("Login down") },
    );
    const calls = mocks.raw.mock.calls.map(([sql]) => sql);
    expect(calls).toContain("BEGIN");
    expect(calls.at(-1)).toBe("COMMIT");
  });
  it("rolls back failed status broadcasts", async () => {
    mocks.fetch.mockResolvedValue({
      indicator: "major",
      description: "Login down",
      incidents: [],
    });
    mocks.active.mockResolvedValue([-100]);
    mocks.enqueue.mockRejectedValueOnce(new Error("db interrupted"));
    await expect(
      statusCheck(Date.parse("2026-10-02T18:00:00Z")),
    ).rejects.toThrow("db interrupted");
    expect(mocks.raw).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
