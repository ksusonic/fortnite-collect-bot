import * as db from "../bot/db";
import type * as fortnite from "../bot/fortnite";
export type TeamDelta = [number, number, number, number];
type Success = [db.EpicLink, fortnite.PlayerStats];
export interface PeriodDelta {
  delta: TeamDelta;
  baselineAt: number;
  fetchedAt: number;
}
export interface LifetimeReport {
  daily: Map<string, TeamDelta>;
  weekly: Map<string, TeamDelta>;
  periods: Map<string, PeriodDelta>;
  partial: Map<string, PeriodDelta>;
  reasons: Map<string, string>;
}
function counters(stats: fortnite.PlayerStats): db.LifetimeSnapshot {
  const mode = stats.overall;
  return {
    epic_account_id: stats.epic_account_id,
    fetched_at: stats.fetched_at,
    matches: mode.matches,
    wins: mode.wins,
    kills: mode.kills,
    deaths_est: mode.deaths ?? mode.matches - mode.wins,
    kd: mode.kd,
  };
}
function delta(
  current: db.LifetimeSnapshot,
  previous: db.LifetimeSnapshot,
): TeamDelta | null {
  const matches = current.matches - previous.matches;
  const wins = current.wins - previous.wins;
  const kills = current.kills - previous.kills;
  const deaths = current.deaths_est - previous.deaths_est;
  if ([matches, wins, kills, deaths].some((n) => n < 0) || wins > matches)
    return null;
  return [matches, wins, kills, deaths > 0 ? kills / deaths : 0];
}
export async function computeLifetimeReport(
  successes: Success[],
  now: number,
): Promise<LifetimeReport> {
  const report: LifetimeReport = {
    daily: new Map(),
    weekly: new Map(),
    periods: new Map(),
    partial: new Map(),
    reasons: new Map(),
  };
  for (const [, stats] of successes) {
    if (stats.time_window !== "lifetime")
      throw new TypeError("weekly statistics require lifetime counters");
    const account = stats.epic_account_id;
    const current = counters(stats);
    const end = Math.min(now, stats.fetched_at);
    const history = await db.get_lifetime_snapshots(
      account,
      now - 8 * 86400,
      end,
    );
    const points = history.filter((p) => p.fetched_at < current.fetched_at);
    points.push(current);
    // A provider correction starts a new observation period. Never bridge a rollback,
    // even if the current counters have already overtaken the old baseline.
    let start = 0;
    for (let i = 1; i < points.length; i++)
      if (!delta(points[i]!, points[i - 1]!)) start = i;
    const valid = points.slice(start);
    const before = (cutoff: number, floor: number) =>
      valid.findLast((p) => p.fetched_at <= cutoff && p.fetched_at >= floor);
    const daily = before(now - 86400, now - 129600);
    if (daily) report.daily.set(account, delta(current, daily)!);
    const baseline = before(now - 604800, now - 691200);
    if (baseline) {
      const d = delta(current, baseline)!;
      report.weekly.set(account, d);
      report.periods.set(account, {
        delta: d,
        baselineAt: baseline.fetched_at,
        fetchedAt: current.fetched_at,
      });
      if (!d[0]) report.reasons.set(account, "не играл за неделю");
    } else {
      const first = valid[0]!;
      if (first.fetched_at < end)
        report.partial.set(account, {
          delta: delta(current, first)!,
          baselineAt: first.fetched_at,
          fetchedAt: current.fetched_at,
        });
      report.reasons.set(
        account,
        start > 0
          ? "счётчики изменились — начали новый период"
          : "начали наблюдение — недельная история ещё копится",
      );
    }
  }
  return report;
}
export async function computeTeamDeltas(
  successes: Success[],
  now: number,
): Promise<[Map<string, TeamDelta>, Map<string, TeamDelta>]> {
  const report = await computeLifetimeReport(successes, now);
  return [report.daily, report.weekly];
}
export function buildWeeklyView(
  successes: Success[],
  deltas: Map<string, TeamDelta>,
  reasons?: Map<string, string>,
): [Success[], [db.EpicLink, string][]] {
  const weekly: Success[] = [],
    missing: [db.EpicLink, string][] = [];
  for (const [link, stats] of successes) {
    const delta = deltas.get(stats.epic_account_id);
    if (!delta) {
      missing.push([
        link,
        reasons?.get(stats.epic_account_id) ?? "нет данных за неделю",
      ]);
      continue;
    }
    const [matches, wins, kills, kd] = delta;
    if (!matches) {
      missing.push([link, "не играл за неделю"]);
      continue;
    }
    const mode = {
      matches,
      wins,
      kills,
      kd,
      win_rate: wins / matches,
      minutes_played: 0,
    };
    weekly.push([
      link,
      { ...stats, overall: mode, solo: null, duo: null, squad: mode },
    ]);
  }
  return [weekly, missing];
}
