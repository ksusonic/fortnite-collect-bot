import * as db from "../db";
import type * as fortnite from "../fortnite";
import * as messages from "../messages";

export type TeamDelta = [number, number, number, number];
export type TeamStatsSuccess = [db.EpicLink, fortnite.PlayerStats];
export async function computeTeamDeltas(
  successes: TeamStatsSuccess[],
  now: number,
): Promise<[Map<string, TeamDelta>, Map<string, TeamDelta>]> {
  const daily = new Map<string, TeamDelta>(),
    weekly = new Map<string, TeamDelta>();
  for (const [, stats] of successes) {
    if (!stats.overall?.matches) continue;
    const current = stats.overall;
    const deaths =
      current.kd > 0 ? messages.roundEven(current.kills / current.kd) : 0;
    for (const [window, age, target] of [
      [86400, 129600, daily],
      [604800, 864000, weekly],
    ] as const) {
      const previous = await db.get_snapshot_before(
        stats.epic_account_id,
        now - window,
        now - age,
      );
      if (
        !previous ||
        previous.overall_matches == null ||
        previous.overall_wins == null ||
        previous.overall_kills == null ||
        previous.overall_deaths_est == null
      )
        continue;
      const matches = current.matches - previous.overall_matches;
      if (matches < 0) continue;
      const kills = current.kills - previous.overall_kills,
        deltaDeaths = deaths - previous.overall_deaths_est;
      target.set(stats.epic_account_id, [
        matches,
        current.wins - previous.overall_wins,
        kills,
        deltaDeaths > 0 ? kills / deltaDeaths : 0,
      ]);
    }
  }
  return [daily, weekly];
}
export function buildWeeklyView(
  successes: TeamStatsSuccess[],
  deltas: Map<string, TeamDelta>,
): [TeamStatsSuccess[], [db.EpicLink, string][]] {
  const weekly: TeamStatsSuccess[] = [],
    missing: [db.EpicLink, string][] = [];
  for (const [link, stats] of successes) {
    const delta = deltas.get(stats.epic_account_id);
    if (!delta) {
      missing.push([link, "нет данных за неделю"]);
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
