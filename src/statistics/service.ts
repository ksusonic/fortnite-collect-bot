import "server-only";
import { createHash } from "node:crypto";
import * as db from "../bot/db";
import {
  callProvider,
  saveSeasonSnapshot,
  FortniteError,
  FortniteUnavailable,
  type PlayerStats,
} from "../bot/fortnite";
import { scopedFetch } from "../bot/transport";
import { invocation, current, advisoryLock } from "../bot/storage";
import { cached, providerSlot, type Cached } from "./cache";
import {
  normalizeProfile,
  profileToSeasonStats,
  type Profile,
  type Window,
} from "./profile";
import { computeTeamDeltas, buildWeeklyView } from "./weekly";
import {
  rank,
  teamSummary,
  teamFacts,
  gatheringSummary,
  type Success,
} from "./summary";
import { generateTeamStatsRoast } from "../bot/roast";

export interface WeeklyPlayer {
  userId: number;
  name: string;
  accountId: string;
  epicName: string;
  matches: number;
  wins: number;
  kills: number;
  kd: number;
  baselineAt: number | null;
  fetchedAt: number;
  stale: boolean;
}
export interface ExcludedPlayer {
  userId: number;
  name: string;
  reason: string;
}
export interface WeeklyReport {
  reportAt: number;
  updatedAt: number | null;
  stale: boolean;
  players: WeeklyPlayer[];
  excluded: ExcludedPlayer[];
  summary: ReturnType<typeof teamSummary>;
  facts: string;
  factsHash: string;
}
export function failureReason(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "StatsPrivate") return "Приватный профиль";
    if (error.name === "StatsEmpty") return "Нет матчей";
    if (error.name === "EpicNameNotFound") return "Аккаунт не найден";
    if (error.message === "rate limited") return "Лимит запросов провайдера";
  }
  return "Провайдер временно недоступен";
}
export async function accountProfile(
  account: string,
  window: Window,
  signal: AbortSignal,
): Promise<Cached<Profile>> {
  // Workers use distinct sessions: transaction and advisory locks never share a client.
  return invocation(
    null,
    () =>
      cached(
        `account:${window}:${account}`,
        900,
        () =>
          providerSlot(async () => {
            const raw = await callProvider(
              { account_id: account, time_window: window },
              scopedFetch,
              signal,
            );
            let profile: Profile;
            try {
              profile = normalizeProfile(raw, window);
            } catch {
              throw new FortniteUnavailable("invalid provider response");
            }
            if (profile.accountId !== account)
              throw new FortniteUnavailable("account mismatch");
            return profile;
          }),
        window === "season"
          ? async (profile) => {
              if (profile.inputs.all.overall)
                await saveSeasonSnapshot(profileToSeasonStats(profile));
            }
          : undefined,
      ),
    signal,
  );
}
export async function weeklyReport(chat: number): Promise<WeeklyReport> {
  const links = await db.get_chat_epic_links(chat);
  const successes: Success[] = [];
  const excluded: ExcludedPlayer[] = [];
  const cacheByAccount = new Map<string, Cached<Profile>>();
  const signal = AbortSignal.any([
    current().signal ?? new AbortController().signal,
    AbortSignal.timeout(60000),
  ]);
  // Deterministic assembly after two bounded workers finish.
  const results: (
    { stats: PlayerStats; cache: Cached<Profile> } | { error: unknown }
  )[] = new Array(links.length);
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next++;
      const link = links[index]!;
      if (signal.aborted) {
        results[index] = { error: new Error("budget exhausted") };
        continue;
      }
      try {
        const cache = await accountProfile(
          link.epic_account_id,
          "season",
          signal,
        );
        results[index] = { stats: profileToSeasonStats(cache.data), cache };
      } catch (error) {
        results[index] = { error };
      }
    }
  };
  await Promise.all([worker(), worker()]);
  for (const [i, link] of links.entries()) {
    const result = results[i]!;
    if ("error" in result)
      excluded.push({
        userId: link.user_id,
        name: link.user_name,
        reason: failureReason(result.error),
      });
    else if (result.cache.error)
      excluded.push({
        userId: link.user_id,
        name: link.user_name,
        reason: "Не удалось обновить профиль; данные устарели",
      });
    else {
      successes.push([link, result.stats]);
      cacheByAccount.set(link.epic_account_id, result.cache);
    }
  }
  const now = Date.now() / 1000;
  const [daily, weekly] = await computeTeamDeltas(successes, now);
  const [view, missing] = buildWeeklyView(successes, weekly);
  excluded.push(
    ...missing.map(([link, reason]) => ({
      userId: link.user_id,
      name: link.user_name,
      reason,
    })),
  );
  const players: WeeklyPlayer[] = [];
  for (const [link, stats] of rank(view)) {
    const baseline = await db.get_snapshot_before(
      stats.epic_account_id,
      now - 604800,
      now - 864000,
    );
    players.push({
      userId: link.user_id,
      name: link.user_name,
      accountId: stats.epic_account_id,
      epicName: stats.epic_name,
      matches: stats.overall.matches,
      wins: stats.overall.wins,
      kills: stats.overall.kills,
      kd: stats.overall.kd,
      baselineAt: baseline?.fetched_at ?? null,
      fetchedAt: stats.fetched_at,
      stale: cacheByAccount.get(stats.epic_account_id)!.stale,
    });
  }
  const facts = teamFacts(view, { weekly_missing: missing, deltas_24h: daily });
  return {
    reportAt: now,
    updatedAt: players.length
      ? Math.min(...players.map((p) => p.fetchedAt))
      : null,
    stale: players.some((p) => p.stale),
    players,
    excluded,
    summary: teamSummary(view),
    facts,
    factsHash: createHash("sha256").update(facts).digest("hex"),
  };
}
export async function gatheringReport(chat: number) {
  return {
    ...gatheringSummary(await db.get_chat_stats(chat)),
    updatedAt: Date.now() / 1000,
  };
}
export async function teamAnalysis(chat: number, report: WeeklyReport) {
  if (!report.facts) return null;
  return cached(`analysis:${chat}:${report.factsHash}`, 3600, async () => {
    const text = await generateTeamStatsRoast(report.facts);
    if (!text) throw new Error("analysis unavailable");
    return { text, reportAt: report.reportAt, factsHash: report.factsHash };
  });
}
export async function lockedChat<T>(chat: number, load: () => Promise<T>) {
  return (await advisoryLock(`chat:${chat}`, load))!;
}
export { FortniteError };
