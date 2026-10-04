vi.mock("../src/bot/commands", () => ({ syncReleaseCommands: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
  enqueue: vi.fn(),
  recover: vi.fn(),
  cleanup: vi.fn(),
  due: vi.fn(),
  snapshots: vi.fn(),
  jobs: vi.fn(),
  weeklyState: vi.fn(),
  chats: vi.fn(),
  active: vi.fn(),
  fetch: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("../src/bot/storage", () => ({
  raw: mocks.raw,
  lockKey: (name: string) => name,
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
  get_chats_with_epic_links: mocks.chats,
  get_active_chat_ids: mocks.active,
}));
vi.mock("../src/bot/status", async (original) => ({
  ...(await original<typeof import("../src/bot/status")>()),
  fetchStatus: mocks.fetch,
}));
vi.mock("../src/bot/snapshots", () => ({
  enqueueDailySnapshots: mocks.snapshots,
}));
import { runJob, statusCheck, weeklyDue } from "../src/bot/jobs";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.raw.mockImplementation(async (sql: string) => ({
    rows: sql.includes("to_regclass")
      ? [{ table_name: null }]
      : sql.includes("SELECT id,status,payload")
        ? sql.includes("WHERE id=$1")
          ? [{ status: "pending", payload: {} }]
          : mocks.jobs()
        : sql.includes("SELECT s.chat_id")
          ? mocks.due()
          : sql.includes("weekly_period")
            ? mocks.weeklyState()
            : [],
    rowCount: 0,
  }));
  mocks.lock.mockImplementation(async (_name: string, fn: () => unknown) =>
    fn(),
  );
  mocks.due.mockReturnValue([]);
  mocks.jobs.mockReturnValue([]);
  mocks.weeklyState.mockReturnValue([]);
  mocks.chats.mockResolvedValue([]);
  mocks.active.mockResolvedValue([]);
});
describe("durable job orchestration", () => {
  it("skips an overlapping lock without enqueueing", async () => {
    mocks.lock.mockResolvedValue(undefined);
    expect(await runJob("maintenance")).toEqual({
      ok: true,
      skipped: "overlap",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("does not repeat a completed job tick", async () => {
    mocks.raw.mockImplementation(async (sql: string) => ({
      rows: sql.includes("SELECT id,status,payload")
        ? [{ status: "complete" }]
        : [],
    }));
    expect(await runJob("cleanup")).toEqual({ ok: true, skipped: "duplicate" });
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it("gates cleanup on a verified import and completes skipped ticks", async () => {
    expect(await runJob("cleanup")).toEqual({
      ok: true,
      skipped: "import not verified",
    });
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.raw).toHaveBeenCalledWith(
      expect.stringContaining("status='complete'"),
      expect.anything(),
    );
  });
  it("enqueues only query-selected due expirations, using fresh tick identities", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-10-02T20:00:00Z"));
    mocks.due.mockReturnValue([{ chat_id: -100, message_id: 9 }]);
    await runJob("expiry");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.stringContaining("expiry:-100:9:"),
      "expiry",
      -100,
      { now: now() / 1000, past_deadline: true },
    );
    expect(mocks.raw).toHaveBeenCalledWith(
      expect.stringContaining("AND NOT EXISTS"),
      [now() / 1000, true, 10800, 3600],
    );
    expect(mocks.recover).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
  it("calculates the most recent due Friday across the deadline and week boundary", () => {
    expect(weeklyDue(Date.parse("2026-10-02T17:59:00Z") / 1000).date).toBe(
      "2026-09-25",
    );
    expect(weeklyDue(Date.parse("2026-10-02T18:00:00Z") / 1000)).toEqual({
      date: "2026-10-02",
      now: Date.parse("2026-10-02T18:00:00Z") / 1000,
    });
    expect(weeklyDue(Date.parse("2026-10-05T18:00:00Z") / 1000).date).toBe(
      "2026-10-02",
    );
  });
  it("catches up weekly reports after the Friday window with a stable period ID", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T19:00:00Z"));
    mocks.chats.mockResolvedValue([-100]);
    await runJob("maintenance");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "weekly:2026-10-02:-100",
      "weekly",
      -100,
      { now: Date.parse("2026-10-02T18:00:00Z") / 1000 },
    );
    expect(mocks.enqueue).not.toHaveBeenCalledWith(
      expect.anything(),
      "job",
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.snapshots).toHaveBeenCalledOnce();
    expect(mocks.recover).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
  it("does not enqueue an already registered weekly period", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-03T19:00:00Z"));
    mocks.weeklyState.mockReturnValue([{ value: { date: "2026-10-02" } }]);
    await runJob("maintenance");
    expect(mocks.chats).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("recovers failed durable expiry jobs with current scheduling time", async () => {
    const original = Date.parse("2026-10-02T18:00:00Z") / 1000;
    mocks.jobs.mockReturnValue([
      {
        id: "job:expiry:123",
        status: "failed",
        payload: { name: "expiry", now: original },
      },
    ]);
    const normal = mocks.raw.getMockImplementation()!;
    mocks.raw.mockImplementation(async (sql: string, args: unknown[]) => {
      if (
        sql.includes("SELECT id,status,payload") &&
        args?.[0] === "job:expiry:123"
      )
        return {
          rows: [
            {
              id: "job:expiry:123",
              status: "failed",
              payload: { name: "expiry", now: original },
            },
          ],
        };
      return normal(sql, args);
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-04T14:00:00Z"));
    await runJob("maintenance");
    expect(mocks.raw).toHaveBeenCalledWith(
      expect.stringContaining("SELECT s.chat_id"),
      [Date.now() / 1000, false, 10800, 3600],
    );
    vi.restoreAllMocks();
    expect(mocks.raw).toHaveBeenCalledWith(
      expect.stringContaining("status='complete'"),
      ["job:expiry:123"],
    );
  });
  it("recovers chat work before a failed provider job without failing maintenance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-04T18:00:00Z"));
    const job = {
      id: "job:status:old",
      status: "failed",
      payload: {
        name: "status",
        now: Date.parse("2026-10-02T18:00:00Z") / 1000,
      },
    };
    mocks.jobs.mockReturnValue([job]);
    const normal = mocks.raw.getMockImplementation()!;
    mocks.raw.mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes("SELECT id,status,payload") && args?.[0] === job.id)
        return { rows: [job] };
      return normal(sql, args);
    });
    mocks.fetch.mockRejectedValueOnce(new Error("provider outage"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runJob("maintenance")).toEqual({ ok: true });
    expect(mocks.recover.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fetch.mock.invocationCallOrder[0],
    );
    expect(mocks.raw).toHaveBeenCalledWith(
      expect.stringContaining("status='failed'"),
      ["Error", job.id],
    );
    log.mockRestore();
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
