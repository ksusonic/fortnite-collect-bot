import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { invocation, migrate, raw } from "../src/bot/storage";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// Validate the actual SQL configuration and retention command on disposable
// Postgres. These minimal cron stand-ins store commands; they do not simulate
// pg_cron execution, pg_net delivery, Vault, or production HTTP outcomes.
suite("schedule SQL configuration and cleanup", () => {
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

  it("updates schedules idempotently and retains the last 30 days", async () => {
    const schedules = await readFile(
      new URL("../ops/schedules.sql", import.meta.url),
      "utf8",
    );
    await invocation(null, async () => {
      if (
        (await raw("SELECT to_regnamespace('cron') AS schema")).rows[0].schema
      )
        throw new Error(
          "schedule stand-ins require a disposable database without cron",
        );
      let created = false;
      try {
        await raw("CREATE SCHEMA cron");
        created = true;
        await raw(`
          CREATE TABLE cron.job (
            jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            jobname text NOT NULL UNIQUE, schedule text NOT NULL, command text NOT NULL
          );
          CREATE FUNCTION cron.schedule(name text, expression text, sql text)
          RETURNS bigint LANGUAGE sql AS $function$
            INSERT INTO cron.job(jobname,schedule,command) VALUES(name,expression,sql)
            ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command
            RETURNING jobid;
          $function$;
          CREATE FUNCTION cron.unschedule(id bigint)
          RETURNS boolean LANGUAGE sql AS $function$
            WITH removed AS (DELETE FROM cron.job WHERE jobid=id RETURNING jobid)
            SELECT EXISTS(SELECT 1 FROM removed);
          $function$;
          INSERT INTO cron.job(jobname,schedule,command) VALUES
            ('fortnite-expiry','* * * * *','SELECT 1'),
            ('fortnite-status','*/3 15-20 * * *','SELECT 1'),
            ('fortnite-weekly','*/5 18 * * 5','SELECT 1'),
            ('fortnite-cleanup','0 1 * * *','SELECT 1');
        `);
        await raw(schedules);
        const first = (
          await raw(
            "SELECT jobid,jobname,schedule,command FROM cron.job ORDER BY jobname",
          )
        ).rows;
        expect(
          first.map(({ jobname, schedule }) => ({ jobname, schedule })),
        ).toEqual([
          { jobname: "fortnite-cleanup", schedule: "0 1 * * *" },
          { jobname: "fortnite-maintenance", schedule: "* * * * *" },
          { jobname: "fortnite-status", schedule: "*/3 15-20 * * *" },
        ]);
        expect(
          first.find((job) => job.jobname === "fortnite-maintenance")!.command,
        ).toContain("/api/jobs/maintenance");
        expect(
          first.find((job) => job.jobname === "fortnite-status")!.command,
        ).toContain("/api/jobs/status");
        await raw(schedules);
        expect(
          (
            await raw(
              "SELECT jobid,jobname,schedule,command FROM cron.job ORDER BY jobname",
            )
          ).rows,
        ).toEqual(first);

        const cleanup = first.find(
          (job) => job.jobname === "fortnite-cleanup",
        )!.command;
        // Keep now() fixed for the exact 30-day boundary. Roll back all fixture
        // data afterwards.
        await raw("BEGIN");
        await raw("TRUNCATE squad_snapshots");
        await raw(`INSERT INTO squad_snapshots(epic_account_id,fetched_at,matches,wins,kills,deaths_est,kd)
          VALUES ('old',now()-interval '31 days',0,0,0,0,0),
                 ('boundary',now()-interval '30 days',0,0,0,0,0),
                 ('recent',now()-interval '29 days',0,0,0,0,0)`);
        await raw("TRUNCATE statistics_cache");
        await raw(`INSERT INTO statistics_cache(cache_key,version,result,fetched_at,expires_at,retry_after)
          VALUES ('old',1,'{}',now(),now()-interval '2 days',NULL),
                 ('boundary',1,'{}',now(),now()-interval '1 day',NULL),
                 ('recent',1,'{}',now(),now()-interval '1 hour',NULL),
                 ('retry',1,'null',now(),now()-interval '2 days',now()+interval '1 minute')`);
        await raw(cleanup);
        expect(
          (
            await raw(
              "SELECT cache_key FROM statistics_cache ORDER BY cache_key",
            )
          ).rows,
        ).toEqual([
          { cache_key: "boundary" },
          { cache_key: "recent" },
          { cache_key: "retry" },
        ]);
        expect(
          (
            await raw(
              "SELECT epic_account_id FROM squad_snapshots ORDER BY epic_account_id",
            )
          ).rows,
        ).toEqual([
          { epic_account_id: "boundary" },
          { epic_account_id: "recent" },
        ]);
      } finally {
        await raw("ROLLBACK");
        if (created) await raw("DROP SCHEMA cron CASCADE");
      }
    });
  });
});
