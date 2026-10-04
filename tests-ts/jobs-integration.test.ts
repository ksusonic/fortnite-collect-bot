vi.mock("../src/bot/commands", () => ({ syncReleaseCommands: vi.fn() }));
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
import { invocation, migrate, raw } from "../src/bot/storage";
vi.mock("../src/bot/runtime", async (original) => ({
  ...(await original<typeof import("../src/bot/runtime")>()),
  createBot: () => ({}),
  recoverPending: vi.fn(),
}));
import { runJob } from "../src/bot/jobs";
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Postgres scheduler decisions", () => {
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
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-04T14:00:00Z"));
    await invocation(null, async () => {
      await raw(
        "TRUNCATE approved_chats,roast_profiles,sessions,responses,epic_links,work_items,work_steps,service_state,chat_features,import_manifest CASCADE",
      );
    });
    await invocation(null, () =>
      raw(
        "INSERT INTO approved_chats(chat_id,approved_by) VALUES (-10,1),(-11,1),(-12,1),(-13,1),(-20,1),(-100,1),(-200,1) ON CONFLICT DO NOTHING",
      ),
    );
  });
  afterEach(() => vi.restoreAllMocks());
  async function session(chat: number, age: number, players: number) {
    await invocation(chat, async () => {
      await db.save_session(
        db.newSession({
          chat_id: chat,
          message_id: 1,
          initiator_id: 1,
          initiator_name: "a",
          created_at: Date.now() / 1000 - age,
        }),
      );
      for (let player = 1; player <= players; player++)
        await db.save_response(1, player, String(player), "go");
    });
  }
  it("enqueues only timed-out sessions, then deduplicates unfinished work and uses new completed identities", async () => {
    await session(-10, 3601, 1);
    await session(-11, 3601, 2);
    await session(-12, 10801, 2);
    await session(-13, 60, 0);
    await runJob("maintenance");
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT chat_id FROM work_items WHERE kind='expiry' ORDER BY chat_id",
          )
        ).rows.map((row) => row.chat_id),
      ).toEqual([-12, -10]);
    });
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-04T14:01:00Z"));
    await runJob("maintenance");
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT count(*)::int AS count FROM work_items WHERE kind='expiry'",
          )
        ).rows[0].count,
      ).toBe(2);
      await raw("UPDATE work_items SET status='complete' WHERE chat_id=-10");
    });
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-04T14:02:00Z"));
    await runJob("maintenance");
    await invocation(null, async () => {
      const work = (
        await raw(
          "SELECT id,status FROM work_items WHERE kind='expiry' AND chat_id=-10 ORDER BY id",
        )
      ).rows;
      expect(work).toHaveLength(2);
      expect(work.map((row) => row.status)).toEqual(["complete", "pending"]);
    });
  });
  it("catches a missed 23:00 deadline after midnight despite traction timeout", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-04T20:50:00Z"));
    await session(-10, 0, 2);
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-04T21:10:00Z"));
    await runJob("maintenance");
    await invocation(null, async () => {
      expect(
        (await raw("SELECT payload FROM work_items WHERE kind='expiry'"))
          .rows[0].payload.past_deadline,
      ).toBe(true);
    });
  });
  it("recovered Friday deadline scheduler cannot expire a new Sunday session", async () => {
    await session(-10, 60, 2);
    await invocation(null, async () => {
      await raw(
        "INSERT INTO work_items(id,kind,payload,status) VALUES ('job:expiry:1','job',$1,'failed')",
        [
          JSON.stringify({
            name: "expiry",
            now: Date.parse("2026-10-02T20:00:00Z") / 1000,
          }),
        ],
      );
    });
    await runJob("maintenance");
    await invocation(null, async () => {
      expect(
        (await raw("SELECT id FROM work_items WHERE kind='expiry'")).rows,
      ).toHaveLength(0);
      expect(
        (await raw("SELECT status FROM work_items WHERE id='job:expiry:1'"))
          .rows[0].status,
      ).toBe("complete");
    });
  });
  it("catches up the current Friday once and never regresses cursor on legacy job recovery", async () => {
    await invocation(null, async () => {
      await raw(
        "INSERT INTO epic_links VALUES (-10,1,'a','epic','account',now())",
      );
      await raw(
        "INSERT INTO work_items(id,kind,payload,status) VALUES ('job:weekly:1','job',$1,'failed')",
        [
          JSON.stringify({
            name: "weekly",
            now: Date.parse("2026-09-04T18:00:00Z") / 1000,
          }),
        ],
      );
    });
    await runJob("maintenance");
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-04T14:01:00Z"));
    await runJob("maintenance");
    await invocation(null, async () => {
      expect(
        (await raw("SELECT id,payload FROM work_items WHERE kind='weekly'"))
          .rows,
      ).toEqual([
        {
          id: "weekly:2026-10-02:-10",
          payload: { now: Date.parse("2026-10-02T18:00:00Z") / 1000 },
        },
      ]);
      expect(
        (await raw("SELECT value FROM service_state WHERE key='weekly_period'"))
          .rows[0].value.date,
      ).toBe("2026-10-02");
    });
  });
});
