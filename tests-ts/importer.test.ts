import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { importBackup } from "../src/bot/importer";
import { invocation, migrate, raw } from "../src/bot/storage";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let directory: string;
let backup: string;
function legacyBackup(extra = "") {
  const sqlite = new DatabaseSync(backup);
  try {
    sqlite.exec(`
      CREATE TABLE sessions(message_id INTEGER PRIMARY KEY,chat_id INTEGER,initiator_id INTEGER,initiator_name TEXT,is_complete INTEGER,created_at REAL);
      CREATE TABLE responses(message_id INTEGER,user_id INTEGER,user_name TEXT,response TEXT,responded_at REAL,PRIMARY KEY(message_id,user_id));
      INSERT INTO sessions VALUES(1,-100,5,'Host',1,100);
      INSERT INTO responses VALUES(1,10,'Alice','go',110);
      ${extra}
    `);
  } finally {
    sqlite.close();
  }
}
const hash = async () =>
  createHash("sha256")
    .update(await readFile(backup))
    .digest("hex");
async function checkEmpty() {
  await invocation(null, async () => {
    for (const table of [
      "sessions",
      "responses",
      "chat_features",
      "import_manifest",
    ])
      expect((await raw(`SELECT * FROM ${table}`)).rows).toEqual([]);
  });
}
suite("read-only SQLite recovery", () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      target.pathname !== "/fortnite_test"
    )
      throw new Error(
        "tests require disposable localhost fortnite_test database",
      );
  });
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", url!);
    vi.stubEnv("DATABASE_LOCAL_TEST", "1");
    await migrate();
    await invocation(null, async () => {
      await raw(
        "TRUNCATE approved_chats,roast_profiles,sessions,responses,chat_features,afk_mutes,roast_state,chat_fort_titles,epic_links,squad_snapshots,fort_cooldowns,work_steps,work_items,service_state,import_manifest,news_sent,fortnite_news_seen,job_http_requests CASCADE",
      );
    });
    directory = await mkdtemp(join(tmpdir(), "fort-import-"));
    backup = join(directory, "backup.db");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it("backfills legacy closure, FIFO and missing titles without changing the backup", async () => {
    legacyBackup();
    const before = await hash();
    const report = await importBackup(backup);
    expect(report.source_sha256).toBe(before);
    expect(await hash()).toBe(before);
    expect(report.tables.sessions.rows).toBe(1);
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT is_closed,fort_title,style,time_slots,tag_line FROM sessions",
          )
        ).rows[0],
      ).toEqual({
        is_closed: true,
        fort_title: null,
        style: 0,
        time_slots: [],
        tag_line: {},
      });
      expect(
        (
          await raw(
            "SELECT chat_id,user_id,EXTRACT(EPOCH FROM joined_at)::double precision AS joined_at FROM responses",
          )
        ).rows[0],
      ).toEqual({ chat_id: -100, user_id: 10, joined_at: 110 });
      expect(
        (await raw("SELECT report,source_sha256 FROM import_manifest")).rows[0],
      ).toEqual({ report: report.tables, source_sha256: before });
      expect((await raw("SELECT * FROM afk_mutes")).rows).toEqual([]);
    });
  });
  it("rolls every table back when normalized content verification fails", async () => {
    legacyBackup(
      "CREATE TABLE chat_features(chat_id INTEGER,feature TEXT,enabled INTEGER); INSERT INTO chat_features VALUES(-100,'roast',1);",
    );
    await expect(
      importBackup(backup, {
        verifyHook: async () => {
          await raw("UPDATE responses SET user_name='Corrupted'");
        },
      }),
    ).rejects.toThrow("import verification failed for responses");
    await checkEmpty();
  });
  it("refuses nonempty runtime state even when legacy target tables are empty", async () => {
    legacyBackup();
    await invocation(null, () =>
      raw("INSERT INTO service_state VALUES('existing','{}')"),
    );
    await expect(importBackup(backup)).rejects.toThrow("not empty");
    await checkEmpty();
    await invocation(null, async () => {
      expect((await raw("SELECT key FROM service_state")).rows[0].key).toBe(
        "existing",
      );
    });
  });
  it("refuses a completed import manifest even for an empty source", async () => {
    legacyBackup();
    await invocation(null, () =>
      raw(
        "INSERT INTO import_manifest(source_sha256,report) VALUES('old','{}')",
      ),
    );
    await expect(importBackup(backup)).rejects.toThrow("not empty");
  });
  it("rejects orphan responses without importing their sessions", async () => {
    legacyBackup("INSERT INTO responses VALUES(999,20,'Bob','go',111)");
    await expect(importBackup(backup)).rejects.toThrow("orphan");
    await checkEmpty();
  });
  it("preserves composite chat/message keys", async () => {
    const sqlite = new DatabaseSync(backup);
    sqlite.exec(`CREATE TABLE sessions(message_id INTEGER,chat_id INTEGER,initiator_id INTEGER,initiator_name TEXT,created_at REAL,PRIMARY KEY(chat_id,message_id));
      CREATE TABLE responses(chat_id INTEGER,message_id INTEGER,user_id INTEGER,user_name TEXT,response TEXT,responded_at REAL);
      INSERT INTO sessions VALUES(1,-100,5,'One',100),(1,-200,6,'Two',101);
      INSERT INTO responses VALUES(-100,1,10,'Alice','go',110),(-200,1,20,'Bob','pass',111);`);
    sqlite.close();
    await importBackup(backup);
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT chat_id,user_id,joined_at FROM responses ORDER BY chat_id DESC",
          )
        ).rows,
      ).toEqual([
        { chat_id: -100, user_id: 10, joined_at: new Date(110000) },
        { chat_id: -200, user_id: 20, joined_at: null },
      ]);
    });
  });
  it("closes older open sessions and preserves the newest one", async () => {
    legacyBackup(
      "UPDATE sessions SET is_complete=0; INSERT INTO sessions VALUES(2,-100,5,'Host',0,101),(3,-100,5,'Host',0,101)",
    );
    await importBackup(backup);
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT message_id,is_closed FROM sessions ORDER BY message_id",
          )
        ).rows,
      ).toEqual([
        { message_id: 1, is_closed: true },
        { message_id: 2, is_closed: true },
        { message_id: 3, is_closed: false },
      ]);
    });
  });
  it("verifies JSON values, archived news and timestamp microseconds", async () => {
    legacyBackup(`ALTER TABLE sessions ADD COLUMN time_slots TEXT; ALTER TABLE sessions ADD COLUMN tag_line TEXT;
      UPDATE sessions SET created_at=100.123456,time_slots='["21:00"]',tag_line='{"10":"Alice"}';
      CREATE TABLE roast_state(chat_id INTEGER,history_json TEXT,roast_msgs_json TEXT,last_roast REAL);
      INSERT INTO roast_state VALUES(-100,'[{"role":"user","text":"hi"}]','invalid',99.999999);
      CREATE TABLE news_sent(chat_id INTEGER,last_version TEXT); INSERT INTO news_sent VALUES(-100,'old');`);
    const report = await importBackup(backup);
    expect(report.tables.news_sent.rows).toBe(1);
    await invocation(null, async () => {
      expect(
        (
          await raw(
            "SELECT EXTRACT(EPOCH FROM created_at)::double precision AS ts,time_slots,tag_line FROM sessions",
          )
        ).rows[0],
      ).toEqual({
        ts: 100.123456,
        time_slots: ["21:00"],
        tag_line: { "10": "Alice" },
      });
      expect(
        (await raw("SELECT history_json,roast_msgs_json FROM roast_state"))
          .rows[0],
      ).toEqual({
        history_json: [{ role: "user", text: "hi" }],
        roast_msgs_json: [],
      });
    });
  });
  it("rolls back before commit if the backup changes during verification", async () => {
    legacyBackup();
    await expect(
      importBackup(backup, {
        verifyHook: async () => {
          const sqlite = new DatabaseSync(backup);
          sqlite.exec("UPDATE sessions SET initiator_name='Changed'");
          sqlite.close();
        },
      }),
    ).rejects.toThrow("backup changed during import");
    await checkEmpty();
  });
  it("refuses unknown source tables", async () => {
    legacyBackup("CREATE TABLE unexpected(secret TEXT)");
    await expect(importBackup(backup)).rejects.toThrow(
      "unrecognized backup tables",
    );
    await checkEmpty();
  });
  it("rejects legacy responses that cannot identify a unique chat", async () => {
    const sqlite = new DatabaseSync(backup);
    sqlite.exec(`CREATE TABLE sessions(message_id INTEGER,chat_id INTEGER,initiator_id INTEGER,initiator_name TEXT,created_at REAL);
      CREATE TABLE responses(message_id INTEGER,user_id INTEGER,user_name TEXT,response TEXT,responded_at REAL);
      INSERT INTO sessions VALUES(1,-100,5,'One',100),(1,-200,6,'Two',101);
      INSERT INTO responses VALUES(1,10,'Alice','go',110);`);
    sqlite.close();
    await expect(importBackup(backup)).rejects.toThrow(
      "ambiguous response parent",
    );
    await checkEmpty();
  });
  it("refuses integer IDs beyond the JavaScript safe range", async () => {
    legacyBackup("UPDATE sessions SET initiator_id=9007199254740993");
    await expect(importBackup(backup)).rejects.toThrow("safe integer range");
    await checkEmpty();
  });
});
