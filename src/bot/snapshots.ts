import { save_squad_snapshot } from "./db";
import {
  callApi,
  EpicNameNotFound,
  isConfigured,
  StatsEmpty,
  StatsPrivate,
  type ModeStats,
  type PlayerStats,
} from "./fortnite";
import { raw } from "./storage";
import { externalCheckpoint } from "./work";

// Each maintenance tick fills a bounded batch. The work ID deduplicates an
// account shared by multiple chats, and subsequent ticks continue the batch.
export async function enqueueDailySnapshots(nowSeconds: number): Promise<void> {
  if (!isConfigured()) return;
  const day = new Date((nowSeconds + 3 * 3600) * 1000)
    .toISOString()
    .slice(0, 10);
  await raw(
    `INSERT INTO work_items(id,kind,chat_id,payload)
     SELECT 'snapshot:' || $1 || ':' || account_id, 'snapshot', NULL,
       jsonb_build_object('account_id', account_id, 'day', $1::text)
     FROM (
       SELECT DISTINCT epic_account_id AS account_id FROM epic_links
       WHERE NOT EXISTS (
         SELECT 1 FROM work_items
         WHERE id = 'snapshot:' || $1 || ':' || epic_links.epic_account_id
       )
       ORDER BY account_id LIMIT 100
     ) accounts
     ON CONFLICT(id) DO NOTHING`,
    [day],
  );
}

function deathsEstimate(mode: ModeStats): number {
  if (mode.kd <= 0) return 0;
  const n = mode.kills / mode.kd;
  const floor = Math.floor(n);
  return n - floor === 0.5
    ? floor % 2 === 0
      ? floor
      : floor + 1
    : Math.round(n);
}

export async function executeSnapshot(
  payload: Record<string, unknown>,
): Promise<void> {
  const account = payload.account_id;
  const day = payload.day;
  if (
    typeof account !== "string" ||
    !account ||
    typeof day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day)
  )
    throw new Error("invalid snapshot payload");
  const result = await externalCheckpoint<
    { stats: PlayerStats } | { skipped: string }
  >(`snapshot:${day}:${account}`, async () => {
    try {
      return { stats: await callApi({ account_id: account }) };
    } catch (error) {
      // Retry network/rate-limit failures without caching their outcome. A
      // private, missing or empty profile can be checked again the next day.
      if (
        error instanceof StatsPrivate ||
        error instanceof EpicNameNotFound ||
        error instanceof StatsEmpty
      )
        return { skipped: error.name };
      throw error;
    }
  });
  if ("skipped" in result) return;
  const stats = result.stats;
  if (stats.epic_account_id !== account)
    throw new Error("snapshot account differs from requested account");
  const squad = stats.squad;
  // This SQL write and its Work database checkpoint commit atomically, outside
  // the external checkpoint, so an interrupted save reuses the original fetch.
  await save_squad_snapshot(
    account,
    stats.fetched_at,
    squad?.matches ?? 0,
    squad?.wins ?? 0,
    squad?.kills ?? 0,
    squad ? deathsEstimate(squad) : 0,
    squad?.kd ?? 0,
    stats.overall.matches,
    stats.overall.wins,
    stats.overall.kills,
    deathsEstimate(stats.overall),
    stats.overall.kd,
  );
}
