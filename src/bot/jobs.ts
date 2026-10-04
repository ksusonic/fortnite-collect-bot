import * as db from "./db";
import { syncReleaseCommands } from "./commands";
import { moscowDate, weeklyDue } from "./schedule-time";
export { moscowDate, weeklyDue } from "./schedule-time";
import * as status from "./status";
import * as messages from "./messages";
import { enqueueDailySnapshots } from "./snapshots";
import { advisoryLock, invocation, lockKey, raw } from "./storage";
import { createBot, enqueue, recoverPending } from "./runtime";

export const JOB_PERIODS = {
  maintenance: 60,
  expiry: 60,
  status: 180,
  weekly: 300,
  cleanup: 86400,
} as const;
export type JobName = keyof typeof JOB_PERIODS;
interface EpicState {
  status: status.ServerStatus | null;
  alerts: Partial<Record<status.Change, number>>;
}
export async function statusCheck(now = Date.now()): Promise<void> {
  const result = await raw(
    "SELECT value FROM service_state WHERE key='epic_status'",
  );
  const state: EpicState = result.rows[0]?.value ?? {
    status: null,
    alerts: {},
  };
  if (moscowDate(now).getUTCHours() < status.ALERT_START_HOUR) {
    state.status = null;
    await saveStatus(state);
    return;
  }
  const current = await status.fetchStatus();
  if (!current) throw new Error("Epic status unavailable");
  const change = status.detectChange(state.status, current);
  await raw("BEGIN");
  try {
    if (
      change &&
      now / 1000 - (state.alerts[change] ?? 0) >= status.ALERT_MIN_INTERVAL_SEC
    ) {
      for (const chat of await db.get_active_chat_ids()) {
        await enqueue(`status:${now / 1000}:${chat}`, "status", chat, {
          text: status.buildAlert(change, current),
        });
      }
      state.alerts[change] = now / 1000;
    }
    state.status = current;
    await saveStatus(state);
    await raw("COMMIT");
  } catch (error) {
    await raw("ROLLBACK");
    throw error;
  }
}
async function saveStatus(state: EpicState) {
  await raw(
    "INSERT INTO service_state(key,value) VALUES ('epic_status',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [JSON.stringify(state)],
  );
}
async function enqueueExpirations(now: number) {
  const pastDeadline =
    moscowDate(now * 1000).getUTCHours() >= messages.PLAY_DEADLINE_HOUR;
  // Suppress a new Telegram task while a
  // failed or ambiguous expiry is awaiting reconciliation. Recheck under the
  // chat lock when executing: players may have joined since this query.
  const sessions = (
    await raw(
      `SELECT s.chat_id,s.message_id,
       ($2 OR (s.created_at AT TIME ZONE 'Europe/Moscow')::date <
         (to_timestamp($1) AT TIME ZONE 'Europe/Moscow')::date) AS past_deadline FROM sessions s
     WHERE EXISTS (SELECT 1 FROM approved_chats a WHERE a.chat_id=s.chat_id)
     AND NOT s.is_closed AND ($2 OR
       (s.created_at AT TIME ZONE 'Europe/Moscow')::date <
         (to_timestamp($1) AT TIME ZONE 'Europe/Moscow')::date OR
       EXTRACT(EPOCH FROM s.created_at) < $1 - CASE WHEN
         (SELECT COUNT(*) FROM responses r WHERE r.chat_id=s.chat_id
          AND r.message_id=s.message_id AND r.response='go') >= 2
       THEN $3::double precision ELSE $4::double precision END)
     AND NOT EXISTS (SELECT 1 FROM work_items w
       WHERE w.kind='expiry' AND w.chat_id=s.chat_id AND w.status<>'complete')
     ORDER BY s.created_at,s.chat_id LIMIT 100`,
      [
        now,
        pastDeadline,
        messages.SESSION_TIMEOUT_TRACTION,
        messages.SESSION_TIMEOUT,
      ],
    )
  ).rows;
  for (const session of sessions) {
    await enqueue(
      `expiry:${session.chat_id}:${session.message_id}:${Math.floor(now / 60)}`,
      "expiry",
      session.chat_id,
      { now, past_deadline: session.past_deadline ?? pastDeadline },
    );
  }
}
async function enqueueWeekly(now: number) {
  const due = weeklyDue(now);
  // One compact cursor replaces a job record for every quiet minute. The cursor
  // commits with enqueues, so a crash cannot silently lose the weekly report.
  await raw("BEGIN");
  try {
    await raw("SELECT pg_advisory_xact_lock($1)", [lockKey("schedule:weekly")]);
    const state = (
      await raw("SELECT value FROM service_state WHERE key='weekly_period'")
    ).rows[0]?.value;
    if (state?.date !== due.date) {
      for (const chat of await db.get_chats_with_epic_links())
        await enqueue(`weekly:${due.date}:${chat}`, "weekly", chat, {
          now: due.now,
        });
      await raw(
        "INSERT INTO service_state(key,value) VALUES ('weekly_period',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify(due)],
      );
    }
    await raw("COMMIT");
  } catch (error) {
    await raw("ROLLBACK");
    throw error;
  }
}
interface JobItem {
  id: string;
  status: string;
  payload: { name?: JobName; now?: number };
}
async function executeJob(
  item: JobItem,
): Promise<{ ok: true; skipped?: string }> {
  const name = item.payload.name;
  if (!name || !Object.hasOwn(JOB_PERIODS, name) || name === "maintenance")
    throw new Error("unknown job");
  await raw(
    "UPDATE work_items SET attempts=attempts+1,updated_at=now() WHERE id=$1",
    [item.id],
  );
  let skipped: string | undefined;
  try {
    if (name === "cleanup") {
      if ((await raw("SELECT 1 FROM import_manifest LIMIT 1")).rows.length)
        await db.cleanup_old_snapshots(30);
      else skipped = "import not verified";
    } else if (name === "status") await statusCheck(Date.now());
    else if (name === "expiry") await enqueueExpirations(Date.now() / 1000);
    else await enqueueWeekly(Date.now() / 1000);
    await raw(
      "UPDATE work_items SET status='complete',error=NULL,updated_at=now() WHERE id=$1",
      [item.id],
    );
    return skipped ? { ok: true, skipped } : { ok: true };
  } catch (error) {
    await raw(
      "UPDATE work_items SET status='failed',error=$1,updated_at=now() WHERE id=$2",
      [error instanceof Error ? error.name : "Error", item.id],
    );
    throw error;
  }
}
async function recoverJobs() {
  const items = (
    await raw<JobItem>(
      "SELECT id,status,payload FROM work_items WHERE kind='job' AND status IN ('pending','failed') ORDER BY updated_at,created_at,id LIMIT 20",
    )
  ).rows;
  for (const item of items) {
    const name = item.payload.name;
    if (!name || !Object.hasOwn(JOB_PERIODS, name)) continue;
    await advisoryLock(
      `job:${name}`,
      async () => {
        // Another request can finish this work while recovery waits for its lock.
        const latest = (
          await raw<JobItem>(
            "SELECT id,status,payload FROM work_items WHERE id=$1",
            [item.id],
          )
        ).rows[0];
        if (!latest || latest.status === "complete") return;
        try {
          await executeJob(latest);
        } catch (error) {
          console.error(
            "job recovery failed",
            item.id,
            error instanceof Error ? error.name : "Error",
          );
        }
      },
      false,
    );
  }
}
export async function runJob(
  name: JobName,
  signal?: AbortSignal,
): Promise<{ ok: true; skipped?: string }> {
  if (!Object.hasOwn(JOB_PERIODS, name)) throw new Error("unknown job");
  const now = Date.now() / 1000;
  return invocation(
    null,
    async () => {
      const registered = await raw(
        "SELECT to_regclass('net._http_response') AS table_name",
      );
      if (registered.rows[0]?.table_name)
        await raw(
          "UPDATE job_http_requests j SET completed_at=r.created,status_code=r.status_code,timed_out=r.timed_out,error=r.error_msg FROM net._http_response r WHERE j.request_id=r.id AND j.completed_at IS NULL",
        );
      const outcome = await advisoryLock(
        `job:${name}`,
        async () => {
          if (name === "maintenance") {
            await enqueueExpirations(now);
            await enqueueWeekly(now);
            await enqueueDailySnapshots(now);
            const bot = createBot();
            await syncReleaseCommands(bot);
            await recoverPending(bot);
            await recoverJobs();
            return { ok: true as const };
          }
          const id = `job:${name}:${Math.floor(now / JOB_PERIODS[name])}`;
          await enqueue(id, "job", null, { name, now });
          const item = (
            await raw<JobItem>(
              "SELECT id,status,payload FROM work_items WHERE id=$1",
              [id],
            )
          ).rows[0];
          if (item.status === "complete")
            return { ok: true as const, skipped: "duplicate" };
          const result = await executeJob({
            ...item,
            id,
            payload: { name, ...item.payload },
          });
          // Compatibility routes still recover chat work, but durable job recovery
          // is independently driven by maintenance and cannot be lost on a new tick.
          await recoverPending(createBot());
          return result;
        },
        false,
      );
      return outcome ?? { ok: true, skipped: "overlap" };
    },
    signal,
  );
}
