import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeProfile,
  profileToSeasonStats,
  profileToStats,
  type ProviderProfile,
} from "../src/statistics/profile";
import {
  rank,
  teamSummary,
  teamFacts,
  gatheringSummary,
  type Success,
} from "../src/statistics/summary";
import {
  buildWeeklyView,
  computeTeamDeltas,
  computeLifetimeReport,
} from "../src/statistics/weekly";
import { buildTeamFnStatsText } from "../src/bot/messages";
import { callProvider } from "../src/bot/fortnite";
const state = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../src/bot/db", () => ({ get_lifetime_snapshots: state.snapshot }));
const raw: ProviderProfile = {
  account: { id: "test", name: "Sanitized" },
  battlePass: { level: 42, progress: 50 },
  stats: {
    all: {
      overall: {
        matches: 10,
        wins: 2,
        kills: 30,
        kd: 3,
        winRate: 20,
        minutesPlayed: 90,
        top10: 6,
      },
    },
    gamepad: {
      solo: {
        matches: 4,
        wins: 1,
        kills: 8,
        kd: 2,
        winRate: 25,
        minutesPlayed: 15,
      },
    },
  },
};
function success(
  id: number,
  matches: number,
  wins: number,
  kills: number,
  kd: number,
): Success {
  const profile = normalizeProfile(
    {
      ...raw,
      account: { id: String(id), name: `Epic ${id}` },
      stats: {
        all: {
          overall: { matches, wins, kills, kd, winRate: 0, minutesPlayed: 0 },
        },
      },
    },
    "lifetime",
    1000000,
  );
  return [
    {
      user_id: id,
      user_name: `Player ${id}`,
      epic_name: profile.epicName,
      epic_account_id: profile.accountId,
      linked_at: 0,
    },
    profileToStats(profile),
  ];
}
beforeEach(() => state.snapshot.mockReset());
describe("shared factual statistics", () => {
  it("normalizes win percentages from counts and absent optional values as unavailable", () => {
    const result = normalizeProfile(raw, "season", 1000);
    expect(result.inputs.all.overall?.winRate).toBe(0.2);
    expect(result.inputs.keyboardMouse.overall).toBeNull();
    expect(result.inputs.gamepad.solo?.winRate).toBe(0.25);
    expect(result.battlePass).toEqual({ level: 42, progress: 0.5 });
    const missing = normalizeProfile(
      {
        account: raw.account,
        stats: {
          all: { overall: { matches: 2, wins: 0, kills: 1, kd: 1 } as never },
        },
      },
      "season",
    );
    expect(missing.inputs.all.overall?.minutesPlayed).toBeNull();
    expect(missing.inputs.all.overall?.placements).toEqual({});
    expect(missing.battlePass).toBeNull();
  });
  it("keeps lifetime responses separate and forbids them from season snapshots", () => {
    expect(() =>
      profileToSeasonStats(normalizeProfile(raw, "lifetime")),
    ).toThrow("lifetime");
  });
  it("requests lifetime explicitly and rejects malformed metrics", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: raw })));
    await callProvider(
      { account_id: "test", time_window: "lifetime" },
      fetcher,
    );
    expect(
      new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("timeWindow"),
    ).toBe("lifetime");
    expect(() =>
      normalizeProfile(
        {
          ...raw,
          stats: {
            all: { overall: { ...raw.stats!.all!.overall!, wins: 99 } },
          },
        },
        "season",
      ),
    ).toThrow();
  });
  it("shares weekly eligibility, MVP, wins/kills ties, aggregate KD and Grok facts with bot rendering", () => {
    const successes = [
      success(1, 100, 5, 60, 3),
      success(2, 80, 6, 80, 4),
      success(3, 90, 6, 90, 3),
      success(4, 10, 0, 0, 0),
      success(5, 10, 1, 1, 1),
    ];
    const deltas = new Map<string, [number, number, number, number]>([
      ["1", [10, 1, 20, 2]],
      ["2", [10, 2, 15, 3]],
      ["3", [20, 2, 30, 3]],
      ["4", [0, 0, 0, 0]],
    ]);
    const [view, missing] = buildWeeklyView(successes, deltas);
    expect(missing.map(([link]) => link.user_id)).toEqual([4, 5]);
    expect(rank(view).map(([link]) => link.user_id)).toEqual([3, 2, 1]);
    expect(teamSummary(view)).toEqual({
      matches: 40,
      wins: 5,
      kills: 65,
      kd: 65 / 25,
      winRate: 5 / 40,
    });
    const [html, facts] = buildTeamFnStatsText(view, [], {
      weekly_missing: missing,
    });
    expect(facts).toBe(teamFacts(view, { weekly_missing: missing }));
    expect(html).toContain("Player 3");
    expect(facts).toContain("MVP недели: Player 3");
    expect(facts).not.toContain("Epic 5");
  });
  it("keeps rolling lifetime deltas independent of seasonal resets", async () => {
    state.snapshot.mockResolvedValue([
      {
        fetched_at: 1000000 - 604800,
        matches: 90,
        wins: 1,
        kills: 40,
        deaths_est: 89,
      },
    ]);
    const [daily, weekly] = await computeTeamDeltas(
      [success(1, 100, 2, 60, 3)],
      1000000,
    );
    expect(daily.size).toBe(0);
    expect(weekly.get("1")).toEqual([10, 1, 20, 20 / 9]);
    expect(state.snapshot).toHaveBeenCalledWith("1", 1000000 - 691200, 1000000);
  });
  it("does not compare counters across a rollback even after they catch up", async () => {
    state.snapshot.mockResolvedValue([
      {
        fetched_at: 1000000 - 604800,
        matches: 90,
        wins: 1,
        kills: 40,
        deaths_est: 89,
      },
      {
        fetched_at: 1000000 - 86400,
        matches: 5,
        wins: 0,
        kills: 10,
        deaths_est: 5,
      },
    ]);
    const report = await computeLifetimeReport(
      [success(1, 100, 2, 60, 3)],
      1000000,
    );
    expect(report.weekly.size).toBe(0);
    expect(report.partial.get("1")?.delta).toEqual([95, 2, 50, 50 / 93]);
    expect(report.reasons.get("1")).toContain("счётчики изменились");
  });
  it("reports the observed partial period without promoting it into weekly rankings", async () => {
    state.snapshot.mockResolvedValue([
      {
        fetched_at: 1000000 - 2 * 86400,
        matches: 90,
        wins: 1,
        kills: 40,
        deaths_est: 89,
      },
    ]);
    const report = await computeLifetimeReport(
      [success(1, 100, 2, 60, 3)],
      1000000,
    );
    expect(report.partial.get("1")?.baselineAt).toBe(1000000 - 2 * 86400);
    expect(report.weekly.size).toBe(0);
    expect(
      buildWeeklyView([success(1, 100, 2, 60, 3)], report.weekly)[0],
    ).toEqual([]);
  });
  it("does not invent zero activity for the first snapshot or use an old baseline", async () => {
    state.snapshot.mockResolvedValue([]);
    const report = await computeLifetimeReport(
      [success(1, 10, 2, 20, 2)],
      1000000,
    );
    expect(report.weekly.size).toBe(0);
    expect(report.partial.size).toBe(0);
    expect(report.reasons.get("1")).toContain("начали наблюдение");
  });
  it("rejects seasonal input instead of mixing histories", async () => {
    const entry = success(1, 10, 2, 20, 2);
    entry[1].time_window = "season";
    await expect(computeLifetimeReport([entry], 1000000)).rejects.toThrow(
      "lifetime",
    );
  });
  it("keeps an observed zero-match week distinct from missing history", async () => {
    state.snapshot.mockResolvedValue([
      {
        fetched_at: 1000000 - 604800,
        matches: 100,
        wins: 2,
        kills: 60,
        deaths_est: 98,
      },
    ]);
    const report = await computeLifetimeReport(
      [success(1, 100, 2, 60, 3)],
      1000000,
    );
    expect(report.weekly.get("1")).toEqual([0, 0, 0, 0]);
    expect(report.reasons.get("1")).toBe("не играл за неделю");
  });
  it("shares gathering completion rate without dividing by zero", () => {
    const data = {
      total_sessions: 10,
      completed_sessions: 4,
      top_players: [],
    } as never;
    expect(gatheringSummary(data).completionRate).toBe(0.4);
    expect(
      gatheringSummary({ ...(data as object), total_sessions: 0 } as never)
        .completionRate,
    ).toBe(0);
  });
});
