import * as db from "./db";
import * as status from "./status";
import { advisoryLock, invocation, raw } from "./storage";
import { createBot, enqueue, recoverPending } from "./runtime";

export const JOB_PERIODS = {
  expiry: 60,
  status: 180,
  weekly: 300,
  cleanup: 86400,
} as const;
export type JobName = keyof typeof JOB_PERIODS;
export function moscowDate(now = Date.now()): Date {
  return new Date(now + 3 * 60 * 60 * 1000);
}
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
export async function runJob(
  name: JobName,
  signal?: AbortSignal,
): Promise<{ ok: true; skipped?: string }> {
  if (!Object.hasOwn(JOB_PERIODS, name)) throw new Error("unknown job");
  const registeredAt = Date.now() / 1000;
  const tick = Math.floor(registeredAt / JOB_PERIODS[name]);
  const workId = `job:${name}:${tick}`;
  return invocation(
    null,
    async () => {
      const registered = await raw(
        "SELECT to_regclass('net._http_response') AS table_name",
      );
      if (registered.rows[0]?.table_name) {
        await raw(
          "UPDATE job_http_requests j SET completed_at=r.created,status_code=r.status_code,timed_out=r.timed_out,error=r.error_msg FROM net._http_response r WHERE j.request_id=r.id AND j.completed_at IS NULL",
        );
      }
      const outcome = await advisoryLock(
        `job:${name}`,
        async () => {
          await enqueue(workId, "job", null, { name, now: registeredAt });
          const row = await raw(
            "SELECT status,payload FROM work_items WHERE id=$1",
            [workId],
          );
          // Persisted job time keeps retries in the same decision window. Legacy
          // job payloads recover their timestamp from the durable tick identifier.
          const savedTime: unknown = row.rows[0]?.payload?.now;
          const now =
            typeof savedTime === "number" && Number.isFinite(savedTime)
              ? savedTime
              : tick * JOB_PERIODS[name];
          if (row.rows[0]?.status === "complete")
            return { ok: true as const, skipped: "duplicate" };
          await raw(
            "UPDATE work_items SET attempts=attempts+1,updated_at=now() WHERE id=$1",
            [workId],
          );
          try {
            if (name === "cleanup") {
              if (
                !(await raw("SELECT 1 FROM import_manifest LIMIT 1")).rows
                  .length
              )
                return { ok: true as const, skipped: "import not verified" };
              await db.cleanup_old_snapshots(30);
            } else if (name === "status") {
              await statusCheck(now * 1000);
            } else if (name === "expiry") {
              for (const session of await db.load_active_sessions()) {
                await enqueue(
                  `expiry:${session.chat_id}:${session.message_id}:${Math.floor(now / 60)}`,
                  "expiry",
                  session.chat_id,
                  {
                    now,
                    past_deadline: moscowDate(now * 1000).getUTCHours() >= 23,
                  },
                );
              }
            } else {
              const current = moscowDate(now * 1000);
              if (current.getUTCDay() === 5 && current.getUTCHours() === 21) {
                for (const chat of await db.get_chats_with_epic_links()) {
                  await enqueue(
                    `weekly:${current.toISOString().slice(0, 10)}:${chat}`,
                    "weekly",
                    chat,
                    { now },
                  );
                }
              }
            }
            await recoverPending(createBot());
            await raw(
              "UPDATE work_items SET status='complete',error=NULL,updated_at=now() WHERE id=$1",
              [workId],
            );
          } catch (error) {
            await raw(
              "UPDATE work_items SET status='failed',error=$1,updated_at=now() WHERE id=$2",
              [error instanceof Error ? error.name : "Error", workId],
            );
            throw error;
          }
          return { ok: true as const };
        },
        false,
      );
      return outcome ?? { ok: true, skipped: "overlap" };
    },
    signal,
  );
}
