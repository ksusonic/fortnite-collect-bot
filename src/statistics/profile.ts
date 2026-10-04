import type {
  PlayerStats,
  RawPlayerStats,
  RawModeStats,
  ModeStats,
} from "../bot/fortnite";
import { toPlayerStats } from "../bot/fortnite";
export const inputs = ["all", "keyboardMouse", "gamepad", "touch"] as const;
export const modes = ["overall", "solo", "duo", "squad"] as const;
export type Window = "season" | "lifetime";
export type Input = (typeof inputs)[number];
export type Mode = (typeof modes)[number];
export interface Performance {
  matches: number;
  wins: number;
  kills: number;
  kd: number;
  winRate: number;
  minutesPlayed: number | null;
  killsPerMatch: number | null;
  placements: Partial<
    Record<"top3" | "top5" | "top6" | "top10" | "top12" | "top25", number>
  >;
}
export interface Profile {
  accountId: string;
  epicName: string;
  window: Window;
  fetchedAt: number;
  inputs: Record<Input, Record<Mode, Performance | null>>;
  battlePass: { level: number | null; progress: number | null } | null;
}
export type ExtendedMode = RawModeStats &
  Partial<
    Record<
      "top3" | "top5" | "top6" | "top10" | "top12" | "top25" | "killsPerMatch",
      number
    >
  >;
export type ProviderProfile = RawPlayerStats & {
  battlePass?: { level?: number; progress?: number } | null;
  stats?: Partial<
    Record<Input, Partial<Record<Mode, ExtendedMode | null>> | null>
  > | null;
};
const optional = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeProfile(
  raw: ProviderProfile,
  window: Window,
  fetchedAt = Date.now() / 1000,
): Profile {
  if (
    !raw?.account ||
    typeof raw.account.id !== "string" ||
    typeof raw.account.name !== "string"
  )
    throw new Error("invalid provider account");
  const mapped = {} as Profile["inputs"];
  for (const input of inputs) {
    mapped[input] = { overall: null, solo: null, duo: null, squad: null };
    for (const mode of modes) {
      const value = raw.stats?.[input]?.[mode];
      if (!value || value.matches === 0) continue;
      if (
        [value.matches, value.wins, value.kills, value.kd].some(
          (v) => optional(v) === null,
        ) ||
        ![value.matches, value.wins, value.kills].every(Number.isInteger) ||
        value.wins > value.matches
      )
        throw new Error("invalid provider metrics");
      const placements: Performance["placements"] = {};
      for (const key of [
        "top3",
        "top5",
        "top6",
        "top10",
        "top12",
        "top25",
      ] as const) {
        const n = optional(value[key]);
        const applicable =
          mode === "overall" ||
          (mode === "solo" && ["top10", "top25"].includes(key)) ||
          (mode === "duo" && ["top5", "top12"].includes(key)) ||
          (mode === "squad" && ["top3", "top6"].includes(key));
        if (n !== null && applicable) placements[key] = n;
      }
      mapped[input][mode] = {
        matches: value.matches,
        wins: value.wins,
        kills: value.kills,
        kd: value.kd,
        winRate: value.wins / value.matches,
        minutesPlayed: optional(value.minutesPlayed),
        killsPerMatch:
          optional(value.killsPerMatch) ?? value.kills / value.matches,
        placements,
      };
    }
  }
  return {
    accountId: raw.account.id,
    epicName: raw.account.name,
    window,
    fetchedAt,
    inputs: mapped,
    battlePass: raw.battlePass
      ? {
          level: optional(raw.battlePass.level),
          progress:
            optional(raw.battlePass.progress) === null
              ? null
              : Math.min(1, raw.battlePass.progress! / 100),
        }
      : null,
  };
}
export function profileToSeasonStats(profile: Profile): PlayerStats {
  if (profile.window !== "season")
    throw new Error("lifetime cannot contribute season snapshots");
  const convert = (p: Performance | null): ModeStats | null =>
    p
      ? {
          matches: p.matches,
          wins: p.wins,
          kills: p.kills,
          kd: p.kd,
          win_rate: p.winRate,
          minutes_played: p.minutesPlayed ?? 0,
        }
      : null;
  // Use the bot's existing empty-profile domain error.
  if (!profile.inputs.all.overall)
    return toPlayerStats(
      { account: { id: profile.accountId, name: profile.epicName } },
      false,
      profile.fetchedAt,
    );
  return {
    epic_account_id: profile.accountId,
    epic_name: profile.epicName,
    overall: convert(profile.inputs.all.overall)!,
    solo: convert(profile.inputs.all.solo),
    duo: convert(profile.inputs.all.duo),
    squad: convert(profile.inputs.all.squad),
    fetched_at: profile.fetchedAt,
    image_url: null,
  };
}
