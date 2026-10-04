import { externalCheckpoint } from "./work";
import { maybeCurrent } from "./storage";
import { scopedFetch } from "./transport";

export class FortniteError extends Error {
  override name = "FortniteError";
}
export class EpicNameNotFound extends FortniteError {
  override name = "EpicNameNotFound";
}
export class StatsPrivate extends FortniteError {
  override name = "StatsPrivate";
}
export class FortniteUnavailable extends FortniteError {
  override name = "FortniteUnavailable";
}
export class StatsEmpty extends FortniteError {
  override name = "StatsEmpty";
  epic_account_id: string;
  epic_name: string;
  constructor({
    epic_account_id,
    epic_name,
  }: {
    epic_account_id: string;
    epic_name: string;
  }) {
    super(`no stats for ${epic_name}`);
    this.epic_account_id = epic_account_id;
    this.epic_name = epic_name;
  }
}
export interface ModeStats {
  matches: number;
  wins: number;
  kills: number;
  kd: number;
  win_rate: number;
  minutes_played: number;
}
export interface PlayerStats {
  epic_account_id: string;
  epic_name: string;
  overall: ModeStats;
  solo: ModeStats | null;
  duo: ModeStats | null;
  squad: ModeStats | null;
  fetched_at: number;
  image_url: string | null;
}
export interface RawModeStats {
  matches: number;
  wins: number;
  kills: number;
  kd: number;
  winRate: number;
  minutesPlayed: number;
}
export interface RawPlayerStats {
  account: { id: string; name: string };
  image?: string | null;
  stats?: {
    all?: {
      overall?: RawModeStats | null;
      solo?: RawModeStats | null;
      duo?: RawModeStats | null;
      squad?: RawModeStats | null;
    } | null;
  } | null;
}
export function isConfigured(): boolean {
  return !!process.env.FORTNITE_API_KEY;
}
export function toMode(raw?: RawModeStats | null): ModeStats | null {
  if (!raw || raw.matches === 0) return null;
  return {
    matches: raw.matches,
    wins: raw.wins,
    kills: raw.kills,
    kd: raw.kd,
    win_rate: raw.wins / raw.matches,
    minutes_played: raw.minutesPlayed,
  };
}
export function toPlayerStats(
  raw: RawPlayerStats,
  withImage: boolean,
  fetchedAt = Date.now() / 1000,
): PlayerStats {
  const all = raw.stats?.all,
    overall = toMode(all?.overall);
  if (!overall)
    throw new StatsEmpty({
      epic_account_id: raw.account.id,
      epic_name: raw.account.name,
    });
  return {
    epic_account_id: raw.account.id,
    epic_name: raw.account.name,
    overall,
    solo: toMode(all?.solo),
    duo: toMode(all?.duo),
    squad: toMode(all?.squad),
    fetched_at: fetchedAt,
    image_url: withImage ? raw.image || null : null,
  };
}
export interface FetchOptions {
  name?: string | null;
  account_id?: string | null;
  with_image?: boolean;
  time_window?: "season" | "lifetime";
}
type FetchResult =
  | { stats: PlayerStats }
  | {
      error: string;
      message: string;
      epic_account_id?: string;
      epic_name?: string;
    };
export async function callProvider(
  options: FetchOptions,
  fetcher: typeof fetch = scopedFetch,
  invocationSignal = maybeCurrent()?.signal,
): Promise<RawPlayerStats> {
  const { name, account_id, with_image = false } = options;
  if ((name == null) === (account_id == null))
    throw new TypeError(
      "fetch_stats requires exactly one of name or account_id",
    );
  const url = new URL(
    `https://fortnite-api.com/v2/stats/br/v2${account_id != null ? `/${encodeURIComponent(account_id)}` : ""}`,
  );
  url.searchParams.set("timeWindow", options.time_window ?? "season");
  url.searchParams.set("image", with_image ? "all" : "none");
  if (name != null) {
    url.searchParams.set("name", name);
    url.searchParams.set("accountType", "epic");
  }
  const timeout = AbortSignal.timeout(
    Number(process.env.FORTNITE_REQUEST_TIMEOUT || 15) * 1000,
  );
  const signal = invocationSignal
    ? AbortSignal.any([timeout, invocationSignal])
    : timeout;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: process.env.FORTNITE_API_KEY || "" },
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (signal.aborted)
      throw new FortniteUnavailable(
        signal.reason?.name === "TimeoutError" ? "timeout" : "request aborted",
      );
    throw new FortniteUnavailable(
      error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : "network error",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 404)
      throw new EpicNameNotFound("epic account not found");
    if (response.status === 403) throw new StatsPrivate("stats are private");
    if (response.status === 429) throw new FortniteUnavailable("rate limited");
    throw new FortniteUnavailable("api error");
  }
  try {
    const json = (await response.json()) as { data: RawPlayerStats };
    return json.data;
  } catch (error) {
    if (error instanceof StatsEmpty) throw error;
    if (signal.aborted)
      throw new FortniteUnavailable(
        signal.reason?.name === "TimeoutError" ? "timeout" : "request aborted",
      );
    throw new FortniteUnavailable("unexpected error");
  }
}
export async function callApi(
  options: FetchOptions,
  fetcher: typeof fetch = scopedFetch,
  invocationSignal = maybeCurrent()?.signal,
): Promise<PlayerStats> {
  const raw = await callProvider(options, fetcher, invocationSignal);
  try {
    return toPlayerStats(raw, options.with_image ?? false);
  } catch (error) {
    if (error instanceof StatsEmpty) throw error;
    throw new FortniteUnavailable("unexpected error");
  }
}
function deathsEstimate(mode: ModeStats): number {
  if (mode.kd <= 0) return 0;
  const n = mode.kills / mode.kd,
    floor = Math.floor(n);
  return n - floor === 0.5
    ? floor % 2 === 0
      ? floor
      : floor + 1
    : Math.round(n);
}
export async function saveSeasonSnapshot(stats: PlayerStats) {
  const { save_squad_snapshot } = await import("./db");
  const sq = stats.squad;
  await save_squad_snapshot(
    stats.epic_account_id,
    stats.fetched_at,
    sq?.matches ?? 0,
    sq?.wins ?? 0,
    sq?.kills ?? 0,
    sq ? deathsEstimate(sq) : 0,
    sq?.kd ?? 0,
    stats.overall.matches,
    stats.overall.wins,
    stats.overall.kills,
    deathsEstimate(stats.overall),
    stats.overall.kd,
  );
}
export async function fetchStats(
  options: FetchOptions = {},
): Promise<PlayerStats> {
  if (options.time_window === "lifetime")
    throw new TypeError("durable bot statistics require season window");
  const { name = null, account_id = null, with_image = false } = options;
  // No process-global cache: invocation replay is supplied by durable checkpoints.
  const result = await externalCheckpoint<FetchResult>(
    `fortnite:${name === null ? "None" : name}:${account_id === null ? "None" : account_id}:${with_image ? "True" : "False"}`,
    async () => {
      try {
        const stats = await callApi(options);
        try {
          await saveSeasonSnapshot(stats);
        } catch {
          console.warn("failed to save squad snapshot");
        }
        return { stats };
      } catch (error) {
        if (!(error instanceof FortniteError)) throw error;
        return {
          error: error.name,
          message: error.message,
          ...(error instanceof StatsEmpty
            ? {
                epic_account_id: error.epic_account_id,
                epic_name: error.epic_name,
              }
            : {}),
        };
      }
    },
  );
  if ("stats" in result) return result.stats;
  if (result.error === "StatsEmpty")
    throw new StatsEmpty({
      epic_account_id: result.epic_account_id!,
      epic_name: result.epic_name!,
    });
  const classes: Record<string, new (message: string) => FortniteError> = {
    EpicNameNotFound,
    StatsPrivate,
    FortniteUnavailable,
  };
  const cls = classes[result.error] || FortniteError;
  throw new cls(result.message);
}
// The shared transport closes its invocation-local dispatcher at invocation exit.
export async function close(): Promise<void> {}
