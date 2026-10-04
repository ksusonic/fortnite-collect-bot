import {
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
  afterEach,
} from "vitest";
import { invocation, migrate, raw, advisoryLock } from "../src/bot/storage";
import { cached, readCache, providerSlot } from "../src/statistics/cache";
import {
  accountProfile,
  weeklyReport,
  teamAnalysis,
  gatheringReport,
} from "../src/statistics/service";
import * as db from "../src/bot/db";
import { StatsPrivate } from "../src/bot/fortnite";
import type { ProviderProfile } from "../src/statistics/profile";
// Production transport uses its matching Undici fetch. Keep provider fixtures
// intercepted without making real external calls during database integration tests.
vi.mock("../src/bot/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bot/transport")>();
  return {
    ...actual,
    scopedFetch: (...args: Parameters<typeof fetch>) =>
      globalThis.fetch(...args),
  };
});
const roast = vi.hoisted(() => vi.fn());
vi.mock("../src/bot/roast", () => ({ generateTeamStatsRoast: roast }));
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const profile: ProviderProfile = {
  account: { id: "test", name: "Sanitized" },
  stats: {
    all: {
      overall: {
        matches: 100,
        wins: 20,
        kills: 300,
        kd: 3,
        winRate: 20,
        minutesPlayed: 900,
      },
      squad: {
        matches: 40,
        wins: 10,
        kills: 120,
        kd: 3,
        winRate: 25,
        minutesPlayed: 300,
      },
    },
  },
};
suite("private statistics cache and snapshot integration", () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      target.pathname !== "/fortnite_test"
    )
      throw new Error("disposable localhost fortnite_test required");
    process.env.DATABASE_URL = url;
    process.env.DATABASE_LOCAL_TEST = "1";
    await migrate();
  });
  beforeEach(async () => {
    roast.mockReset();
    await invocation(null, () =>
      raw(
        "TRUNCATE statistics_cache,squad_snapshots,epic_links,sessions CASCADE",
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it("enables RLS and grants no public access", async () => {
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT relrowsecurity FROM pg_class WHERE oid='fortnite_bot.statistics_cache'::regclass",
          )
        ).rows[0].relrowsecurity,
      ).toBe(true);
      expect(
        (
          await raw(
            "SELECT grantee FROM information_schema.role_table_grants WHERE table_schema='fortnite_bot' AND table_name='statistics_cache' AND grantee IN ('PUBLIC','anon','authenticated')",
          )
        ).rowCount,
      ).toBe(0);
    });
  });
  it("reuses fresh results, refreshes expired results, coalesces simultaneous invocations", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const begin = new Promise<void>((resolve) => {
      started = resolve;
    });
    const load = vi.fn(async () => {
      started();
      await gate;
      return { value: 1 };
    });
    const first = invocation(null, () => cached("test", 900, load));
    await begin;
    const second = invocation(null, () => cached("test", 900, load));
    release();
    expect((await Promise.all([first, second])).map((r) => r.data)).toEqual([
      { value: 1 },
      { value: 1 },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    await invocation(null, async () => {
      await cached("test", 900, load);
      expect(load).toHaveBeenCalledTimes(1);
      await raw(
        "UPDATE statistics_cache SET expires_at=now()-interval '1 second'",
      );
      await cached("test", 900, load);
      expect(load).toHaveBeenCalledTimes(2);
    });
  });
  it("rolls snapshot and cache back together if commit fails", async () => {
    await expect(
      invocation(null, () =>
        cached(
          "bad",
          900,
          async () => ({ value: 1 }),
          async () => {
            await raw(
              "INSERT INTO service_state VALUES('cache-rollback','{}')",
            );
            throw new Error("commit failed");
          },
        ),
      ),
    ).rejects.toThrow("commit failed");
    await invocation(null, async () => {
      expect(await readCache("bad")).toBeNull();
      expect(
        (await raw("SELECT 1 FROM service_state WHERE key='cache-rollback'"))
          .rowCount,
      ).toBe(0);
    });
  });
  it("returns stale results on rate limit, retries with backoff, invalidates private accounts", async () => {
    await invocation(null, async () => {
      await cached("test", 900, async () => ({ value: 1 }));
      await raw(
        "UPDATE statistics_cache SET expires_at=now()-interval '1 second'",
      );
      const failed = vi.fn(async () => {
        throw new Error("rate limited");
      });
      expect((await cached("test", 900, failed)).stale).toBe(true);
      expect((await cached("test", 900, failed)).error).toBeTruthy();
      expect(failed).toHaveBeenCalledTimes(1);
      await raw("UPDATE statistics_cache SET retry_after=NULL");
      await expect(
        cached("test", 900, async () => {
          throw new StatsPrivate("private");
        }),
      ).rejects.toBeInstanceOf(StatsPrivate);
      expect(await readCache("test")).toBeNull();
    });
  });
  it("backs off failures without a previous successful result", async () => {
    const load = vi.fn(async () => {
      throw new Error("rate limited");
    });
    await expect(
      invocation(null, () => cached("cold", 900, load)),
    ).rejects.toThrow("rate limited");
    await expect(
      invocation(null, () => cached("cold", 900, load)),
    ).rejects.toThrow("cache cooldown");
    expect(load).toHaveBeenCalledTimes(1);
    await invocation(null, async () => {
      expect(await readCache("cold")).toBeNull();
      await raw(
        "UPDATE statistics_cache SET retry_after=now()-interval '1 second' WHERE cache_key='cold'",
      );
      expect(
        (await cached("cold", 900, async () => ({ value: 1 }))).data,
      ).toEqual({ value: 1 });
    });
  });
  it("permits no more than two concurrent provider calls across sessions", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let count = 0;
    let started!: () => void;
    const begin = new Promise<void>((resolve) => (started = resolve));
    const load = async () => {
      if (++count === 2) started();
      await gate;
      return count;
    };
    const running = [
      invocation(null, () => providerSlot(load)),
      invocation(null, () => providerSlot(load)),
    ];
    await begin;
    await expect(
      invocation(null, () => providerSlot(async () => 3)),
    ).rejects.toThrow("provider busy");
    release();
    await Promise.all(running);
    expect(count).toBe(2);
  });
  it("isolates lifetime cache and writes season snapshots only once", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: profile })),
      );
    vi.stubGlobal("fetch", fetcher);
    await accountProfile("test", "lifetime", AbortSignal.timeout(5000));
    await invocation(null, async () => {
      expect((await raw("SELECT * FROM squad_snapshots")).rowCount).toBe(0);
    });
    await accountProfile("test", "season", AbortSignal.timeout(5000));
    await accountProfile("test", "season", AbortSignal.timeout(5000));
    await invocation(null, async () => {
      expect((await raw("SELECT * FROM squad_snapshots")).rowCount).toBe(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("returns partial weekly results with actual baseline timestamps and excludes provider failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).includes("private")
            ? new Response("", { status: 403 })
            : new Response(JSON.stringify({ data: profile })),
        ),
    );
    await invocation(-100, async () => {
      await raw(
        "INSERT INTO sessions(chat_id,message_id,initiator_id,initiator_name,created_at) VALUES (-100,99999,1,'User',now()) ON CONFLICT DO NOTHING",
      );
      await raw(
        "INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at) SELECT -100,99999,n,'User','go',now() FROM generate_series(1,2) n ON CONFLICT DO NOTHING",
      );
      await db.save_epic_link(1, "Player", "Sanitized", "test");
      await db.save_epic_link(2, "Private", "Private", "private");
      const baseline = Date.now() / 1000 - 7 * 86400 - 60;
      await db.save_squad_snapshot(
        "test",
        baseline,
        10,
        2,
        30,
        10,
        3,
        80,
        10,
        200,
        80,
        2.5,
      );
      const report = await weeklyReport(-100);
      expect(report.players).toHaveLength(1);
      expect(report.players[0].baselineAt).toBeCloseTo(baseline, 4);
      expect(report.summary).toEqual({
        matches: 20,
        wins: 10,
        kills: 100,
        kd: 5,
        winRate: 0.5,
      });
      expect(report.excluded).toEqual([
        { userId: 2, name: "Private", reason: "Приватный профиль" },
      ]);
      expect(report.facts).not.toContain("Private");
      roast.mockResolvedValue("Analysis");
      const first = await teamAnalysis(-100, report);
      const second = await teamAnalysis(-100, report);
      expect(first?.data).toEqual(second?.data);
      expect(roast).toHaveBeenCalledTimes(1);
      expect(first?.data.reportAt).toBe(report.reportAt);
    });
  });
  it("preserves chat advisory lock isolation and gathering service parity", async () => {
    await invocation(-100, async () => {
      await advisoryLock("chat:-100", async () => {
        await db.save_session(
          db.newSession({
            chat_id: -100,
            message_id: 1,
            initiator_id: 1,
            initiator_name: "Player",
            is_complete: true,
            created_at: 1000,
            completed_at: 1060,
          }),
        );
        const report = await gatheringReport(-100);
        const bot = await db.get_chat_stats(-100);
        expect(report.completionRate).toBe(1);
        expect(report.avg_fill_seconds).toBe(60);
        expect(report.top_initiators).toEqual(bot.top_initiators);
        expect(report.best_hours).toEqual(bot.best_hours);
      });
    });
  });
});
