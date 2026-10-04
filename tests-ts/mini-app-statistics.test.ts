import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeProfile,
  profileToSeasonStats,
  type ProviderProfile,
} from "../src/statistics/profile";
import {
  rank,
  teamSummary,
  teamFacts,
  gatheringSummary,
  type Success,
} from "../src/statistics/summary";
import { buildWeeklyView, computeTeamDeltas } from "../src/statistics/weekly";
import { buildTeamFnStatsText } from "../src/bot/messages";
import { callProvider } from "../src/bot/fortnite";
const state = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../src/bot/db", () => ({ get_snapshot_before: state.snapshot }));
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
    "season",
    1000,
  );
  return [
    {
      user_id: id,
      user_name: `Player ${id}`,
      epic_name: profile.epicName,
      epic_account_id: profile.accountId,
      linked_at: 0,
    },
    profileToSeasonStats(profile),
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
  it("ignores season counter resets even when matches increased", async () => {
    state.snapshot.mockResolvedValue({
      overall_matches: 90,
      overall_wins: 20,
      overall_kills: 500,
      overall_deaths_est: 100,
    });
    const [daily, weekly] = await computeTeamDeltas(
      [success(1, 100, 1, 60, 3)],
      1000000,
    );
    expect(daily.size).toBe(0);
    expect(weekly.size).toBe(0);
  });
  it("uses bounded seven-day baseline and excludes missing baseline", async () => {
    state.snapshot.mockResolvedValue(null);
    const result = await computeTeamDeltas([success(1, 10, 2, 20, 2)], 1000000);
    expect(result[1].size).toBe(0);
    expect(state.snapshot).toHaveBeenCalledWith(
      "1",
      1000000 - 604800,
      1000000 - 864000,
    );
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
