import { enqueueConversationMemory } from "./services/conversation-memory";
import { cleanupConversations } from "./services/conversation-store";
import * as Sentry from "@sentry/nextjs";
import { diagnosticTags } from "../sentry-options";
import { logEvent, workReference, errorFields } from "./logging";
import * as db from "./db";
import { ensureReleaseCommands } from "./commands";
import { syncReleaseWebhook } from "./webhook";
import { moscowDate, weeklyDue } from "./schedule-time";
export { moscowDate, weeklyDue } from "./schedule-time";
import * as status from "./status";
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
  try {
    if (name === "cleanup") {
      await db.cleanup_old_snapshots(30);
      await cleanupConversations();
    } else if (name === "status") await statusCheck(Date.now());
    else if (name === "expiry") {
      // Compatibility URL: gathering scheduling has been retired.
    } else await enqueueWeekly(Date.now() / 1000);
    await raw(
      "UPDATE work_items SET status='complete',error=NULL,updated_at=now() WHERE id=$1",
      [item.id],
    );
    return { ok: true };
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
          Sentry.captureException(error, {
            tags: {
              component: "job_recovery",
              work_ref: workReference(item.id),
              ...diagnosticTags(error),
            },
          });
          logEvent("error", "job.recovery_failed", {
            work_ref: workReference(item.id),
            ...errorFields(error),
          });
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
  const started = performance.now();
  logEvent("info", "job.started", { work_kind: name });
  try {
    const result = await invocation(
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
              await enqueueWeekly(now);
              await enqueueDailySnapshots(now);
              await enqueueConversationMemory(now);
              const bot = createBot();
              await ensureReleaseCommands(bot);
              await syncReleaseWebhook(bot);
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
        return outcome ?? { ok: true as const, skipped: "overlap" };
      },
      signal,
    );
    logEvent("info", "job.completed", {
      work_kind: name,
      status: result.skipped ?? "complete",
      duration_ms: Math.round(performance.now() - started),
    });
    return result;
  } catch (error) {
    logEvent("error", "job.failed", {
      work_kind: name,
      ...errorFields(error),
      duration_ms: Math.round(performance.now() - started),
    });
    throw error;
  }
}
