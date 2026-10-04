import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as db from "../src/bot/db";
import {
  FortniteUnavailable,
  StatsPrivate,
  type PlayerStats,
} from "../src/bot/fortnite";
import { enqueueDailySnapshots, executeSnapshot } from "../src/bot/snapshots";
import { invocation, migrate, raw, withWork } from "../src/bot/storage";
import { Work } from "../src/bot/work";

const provider = vi.hoisted(() => vi.fn());
vi.mock("../src/bot/fortnite", async (original) => ({
  ...(await original<typeof import("../src/bot/fortnite")>()),
  callApi: provider,
}));

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const now = Date.parse("2026-10-04T12:00:00Z") / 1000;
const payload = { account_id: "shared", day: "2026-10-04" };
const id = "snapshot:2026-10-04:shared";
const stats: PlayerStats = {
  epic_account_id: "shared",
  epic_name: "Shared",
  fetched_at: now,
  image_url: null,
  solo: null,
  duo: null,
  squad: null,
  overall: {
    matches: 20,
    wins: 3,
    kills: 45,
    kd: 2,
    win_rate: 15,
    minutes_played: 200,
  },
};
suite("daily durable snapshots", () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      !target.pathname.endsWith("/fortnite_test")
    )
      throw new Error(
        "tests require disposable localhost fortnite_test database",
      );
    process.env.DATABASE_URL = url;
    process.env.DATABASE_LOCAL_TEST = "1";
    await migrate();
  });
  beforeEach(async () => {
    provider.mockReset();
    provider.mockResolvedValue(stats);
    vi.stubEnv("FORTNITE_API_KEY", "test-key");
    await invocation(null, async () => {
      await raw(
        "TRUNCATE sessions,responses,approved_chats,roast_profiles,work_steps,work_items,epic_links,squad_snapshots CASCADE",
      );
      await raw(
        "INSERT INTO sessions(chat_id,message_id,initiator_id,initiator_name,created_at) VALUES (-10,99999,1,'User',now()) ON CONFLICT DO NOTHING",
      );
      await raw(
        "INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at) SELECT -10,99999,n,'User','go',now() FROM generate_series(1,1) n ON CONFLICT DO NOTHING",
      );
      await raw(
        "INSERT INTO sessions(chat_id,message_id,initiator_id,initiator_name,created_at) VALUES (-20,99999,1,'User',now()) ON CONFLICT DO NOTHING",
      );
      await raw(
        "INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at) SELECT -20,99999,n,'User','go',now() FROM generate_series(2,2) n ON CONFLICT DO NOTHING",
      );
      await db.save_epic_link(1, "one", "Shared", "shared");
      await db.save_epic_link(2, "two", "Shared", "shared");
      await raw(
        "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1) ON CONFLICT DO NOTHING",
      );
      await enqueueDailySnapshots(now);
    });
    await invocation(null, () =>
      raw(
        "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1),(-11,1),(-12,1),(-13,1),(-20,1),(-100,1),(-200,1) ON CONFLICT DO NOTHING",
      ),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const collect = () =>
    invocation(null, () =>
      withWork(new Work(id), () => executeSnapshot(payload)),
    );

  it("collects one account shared across quiet chats once per Moscow day", async () => {
    await invocation(null, async () => {
      await enqueueDailySnapshots(now + 3600);
      expect((await raw("SELECT id FROM work_items")).rows).toEqual([{ id }]);
      await enqueueDailySnapshots(Date.parse("2026-10-04T21:00:00Z") / 1000);
      expect((await raw("SELECT id FROM work_items ORDER BY id")).rows).toEqual(
        [{ id }, { id: "snapshot:2026-10-05:shared" }],
      );
    });
    await collect();
    await collect();
    expect(provider).toHaveBeenCalledOnce();
    await invocation(null, async () => {
      const snapshots = (await raw("SELECT * FROM squad_snapshots")).rows;
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        epic_account_id: "shared",
        matches: 0,
        overall_matches: 20,
        overall_deaths_est: 22,
      });
      expect(
        (await raw("SELECT step FROM work_steps WHERE work_id=$1", [id])).rows,
      ).toHaveLength(2);
    });
  });
  it("replays the original fetch after a snapshot write fails", async () => {
    const save = vi.spyOn(db, "save_squad_snapshot");
    save.mockRejectedValueOnce(new Error("save interrupted"));
    await expect(collect()).rejects.toThrow("save interrupted");
    await collect();
    expect(provider).toHaveBeenCalledOnce();
    await invocation(null, async () => {
      expect(
        (await raw("SELECT fetched_at FROM squad_snapshots")).rows,
      ).toEqual([{ fetched_at: new Date(now * 1000) }]);
    });
  });
  it("retries transient provider failure instead of caching it", async () => {
    provider.mockRejectedValueOnce(new FortniteUnavailable("rate limited"));
    await expect(collect()).rejects.toThrow("rate limited");
    await collect();
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it("checkpoints a private profile without creating an invalid baseline", async () => {
    provider.mockRejectedValueOnce(new StatsPrivate("stats are private"));
    await collect();
    await collect();
    expect(provider).toHaveBeenCalledOnce();
    await invocation(null, async () => {
      expect((await raw("SELECT * FROM squad_snapshots")).rows).toEqual([]);
    });
  });
  it("bounds each enqueue batch while later ticks continue with other accounts", async () => {
    await invocation(null, async () => {
      await raw(
        "TRUNCATE sessions,responses,approved_chats,roast_profiles,work_steps,work_items,epic_links CASCADE",
      );
      await raw(
        "INSERT INTO sessions(chat_id,message_id,initiator_id,initiator_name,created_at) VALUES (-10,99999,1,'User',now()) ON CONFLICT DO NOTHING",
      );
      await raw(
        "INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at) SELECT -10,99999,n,'User','go',now() FROM generate_series(1,105) n ON CONFLICT DO NOTHING",
      );
      await raw(`INSERT INTO epic_links(user_id,user_name,epic_name,epic_account_id,linked_at)
        SELECT n,'user','Epic','account:' || n,now() FROM generate_series(1,105) n`);
      await raw(
        "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1) ON CONFLICT DO NOTHING",
      );
      await enqueueDailySnapshots(now);
      expect(
        (await raw("SELECT count(*) AS count FROM work_items")).rows[0].count,
      ).toBe(100);
      await raw(
        "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1) ON CONFLICT DO NOTHING",
      );
      await enqueueDailySnapshots(now);
      expect(
        (await raw("SELECT count(*) AS count FROM work_items")).rows[0].count,
      ).toBe(105);
    });
  });
});
