import { describe, expect, it } from "vitest";
import fixture from "./fixtures/messages-parity.json";
import type { ChatStats, EpicLink, Session } from "../src/bot/db";
import {
  EpicNameNotFound,
  FortniteUnavailable,
  StatsEmpty,
  StatsPrivate,
  type PlayerStats,
} from "../src/bot/fortnite";
import {
  buildCancelledText,
  buildExpiredText,
  buildGatherText,
  buildKeyboard,
  buildMyFnStatsText,
  buildStatsText,
  buildUnifiedStatsText,
  buildTeamFnStatsText,
  generateTimeSlots,
  formatFixed,
  escapeHtml,
  myFnCaption,
  splitRoster,
  type Success,
} from "../src/bot/messages";

function hydrate(raw: (typeof fixture.sessions)[number]["session"]): Session {
  return {
    ...raw,
    go_players: new Map(raw.go_players as [number, string][]),
    pass_players: new Map(raw.pass_players as [number, string][]),
    player_slots: new Map(raw.player_slots as [number, string][]),
    tagged_users: new Map(raw.tagged_users as [number, string][]),
  } as Session;
}
describe("message rendering fixtures", () => {
  for (const example of fixture.sessions)
    it(`preserves stored style ${example.session.style}, roster, escaping and lifecycle text`, () => {
      const session = hydrate(example.session);
      const text = buildGatherText(session, fixture.now);
      expect(text.split("\n")[0]).toBe(example.gather.split("\n")[0]);
      expect(text).toContain("готовы играть 0/");
      for (const name of session.go_players.values())
        expect(text).toContain(escapeHtml(name));
      expect(text).not.toContain("Все четверо в сборе");
      expect(buildExpiredText(session, fixture.now)).toContain(
        "Вечер завершён",
      );
      expect(buildCancelledText(session, fixture.now)).toContain(
        "Сбор отменён",
      );
    });
  it("preserves every chat stats template", () => {
    fixture.stats_texts.forEach((expected, i) =>
      expect(buildStatsText(fixture.stats as ChatStats, i)).toBe(expected),
    );
  });
  it("preserves personal image captions and text fallback", () => {
    expect(
      myFnCaption(fixture.link as EpicLink, fixture.player as PlayerStats),
    ).toBe(fixture.caption);
    expect(
      buildMyFnStatsText(
        fixture.link as EpicLink,
        fixture.player as PlayerStats,
      ),
    ).toBe(fixture.player_text);
  });
  it("preserves weekly MVP, leaders, failure groups, exclusions and LLM facts", () => {
    const link = fixture.link as EpicLink;
    const [html, facts] = buildTeamFnStatsText(
      fixture.team_successes as Success[],
      [
        [link, new StatsPrivate("private")],
        [link, new StatsEmpty({ epic_account_id: "abc", epic_name: "empty" })],
        [link, new EpicNameNotFound("missing")],
        [link, new FortniteUnavailable("no")],
      ],
      {
        weekly_missing: fixture.team_missing as [EpicLink, string][],
        deltas_24h: { "0": [0, 0, 0, 0], "1": [2, 1, 10, 2.5] },
      },
    );
    expect(html).toBe(fixture.team_text);
    expect(facts).toBe(fixture.team_facts);
  });
  it("keeps FIFO membership even when IDs are numerically unordered", () => {
    const session = hydrate(fixture.sessions[1]!.session);
    const [squad, reserve] = splitRoster(session);
    expect([...squad.keys()]).toEqual([20, 2, 90, 3]);
    expect([...reserve.keys()]).toEqual([1, 4]);
    expect([...session.go_players.keys()]).toEqual([20, 2, 90, 3, 1, 4]);
  });
});
describe("numeric rendering", () => {
  it("preserves half-even ties and binary float behavior", () => {
    expect(formatFixed(2.625, 2)).toBe("2.62");
    expect(formatFixed(2.675, 2)).toBe("2.67");
    expect(formatFixed(1.125, 2)).toBe("1.12");
    expect(formatFixed(1.375, 2)).toBe("1.38");
    expect(formatFixed(-0, 2)).toBe("-0.00");
  });
});
describe("relative readiness offers", () => {
  const at = (time: string) => Date.parse(`2026-10-03T${time}+03:00`) / 1000;
  it("trims relative offers at midnight", () => {
    expect(generateTimeSlots(null, at("21:59:59"))).toEqual([
      "now",
      "30",
      "60",
      "120",
    ]);
    expect(generateTimeSlots(null, at("22:00:01"))).toEqual([
      "now",
      "30",
      "60",
    ]);
    expect(generateTimeSlots(null, at("23:30:01"))).toEqual(["now"]);
  });
  it("keeps pinned absolute slots and callback shapes", () => {
    expect(generateTimeSlots(20, at("22:30:01"))).toEqual(["20:00"]);
    expect(
      buildKeyboard(4, ["now", "30", "60", "120", "20:00"]).inline_keyboard[0],
    ).toEqual([
      { text: "⚡ Сейчас", callback_data: "slot:now" },
      { text: "🕐 +30м", callback_data: "slot:30" },
      { text: "🕐 +1ч", callback_data: "slot:60" },
      { text: "🕐 +2ч", callback_data: "slot:120" },
      { text: "🕐 20:00", callback_data: "slot:20:00" },
    ]);
    expect(buildKeyboard(3).inline_keyboard[0]![0]).toEqual({
      text: "✅ Go (3/4)",
      callback_data: "go",
    });
  });
});

describe("unified weekly statistics", () => {
  const now = 1794124800;
  const empty = () => ({
    daily: new Map(),
    weekly: new Map(),
    periods: new Map(),
    partial: new Map(),
    reasons: new Map(),
  });
  it("keeps gatherings available with a clear game-data status and no decorative table", () => {
    const html = buildUnifiedStatsText({
      now,
      gatherings: fixture.stats as ChatStats,
      successes: [],
      weeklyView: [],
      report: empty(),
      notices: [],
      status: "🔗 Нет Epic-аккаунтов",
    });
    expect(html).toContain("🎮 <b>Сборы Fortnite</b>");
    expect(html).toContain("🔗 Нет Epic-аккаунтов");
    expect(html).not.toMatch(/[─█░]|<pre>/);
    expect(html).not.toContain("MVP");
  });
  it("does not equate a two-player gathering with failure or claim that signups prove play", () => {
    const html = buildUnifiedStatsText({
      now,
      gatherings: {
        ...fixture.stats,
        total_sessions: 3,
        company_sessions: 2,
        completed_sessions: 0,
        avg_fill_seconds: null,
      } as ChatStats,
      successes: [],
      weeklyView: [],
      report: empty(),
      notices: [],
    });
    expect(html).toContain("👥 Записались 2+ человека: <b>2</b> из 3 сборов");
    expect(html).toContain("🎯 Набрался сквад из 4: <b>0</b>");
    expect(html).not.toMatch(/Успешных|Собрались|0%/);
  });
  it("shows actual partial periods without weekly awards and escapes every name", () => {
    const entry = [fixture.link, fixture.player] as Success;
    const report = empty();
    report.partial.set(entry[1].epic_account_id, {
      delta: [4, 1, 12, 3],
      baselineAt: now - 86400,
      fetchedAt: now,
    });
    const html = buildUnifiedStatsText({
      now,
      gatherings: fixture.stats as ChatStats,
      successes: [entry],
      weeklyView: [],
      report,
      notices: [[entry[0], "начали наблюдение"]],
    });
    expect(html).toContain("Доступный период");
    expect(html).toContain("4 матчей");
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).not.toContain("MVP");
    expect(html).not.toContain("👤");
  });
  it("does not describe a measured inactive week as missing history", () => {
    const report = empty();
    report.weekly.set("id", [0, 0, 0, 0]);
    const html = buildUnifiedStatsText({
      now,
      gatherings: fixture.stats as ChatStats,
      successes: [],
      weeklyView: [],
      report,
      notices: [],
    });
    expect(html).toContain("нет сыгранных матчей");
    expect(html).not.toContain("копится");
  });
  it("bounds long escaped names and mixed player lists within one Telegram message", () => {
    const entries = Array.from(
      { length: 40 },
      (_, id) =>
        [
          {
            ...fixture.link,
            user_id: id,
            user_name: "<&".repeat(100),
            epic_account_id: String(id),
          },
          { ...fixture.player, epic_account_id: String(id) },
        ] as Success,
    );
    const report = empty();
    for (const [, s] of entries) {
      report.periods.set(s.epic_account_id, {
        delta: [20, 5, 70, 3.5],
        baselineAt: now - 604800,
        fetchedAt: now,
      });
      report.partial.set(s.epic_account_id, {
        delta: [1, 0, 1, 1],
        baselineAt: now - 86400,
        fetchedAt: now,
      });
    }
    const html = buildUnifiedStatsText({
      now,
      gatherings: fixture.stats as ChatStats,
      successes: entries,
      weeklyView: entries,
      report,
      notices: [],
    });
    expect(html.length).toBeLessThanOrEqual(3500);
    expect(html).not.toContain("<&");
    expect(html).toContain("MVP недели");
  });
});
