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
  buildTeamFnStatsText,
  generateTimeSlots,
  formatFixed,
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
      expect(buildGatherText(session, fixture.now)).toBe(example.gather);
      expect(buildExpiredText(session, fixture.now)).toBe(example.expired);
      expect(buildCancelledText(session, fixture.now)).toBe(example.cancelled);
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
  it("trims relative offers at 23:00 with exact boundary parity", () => {
    expect(generateTimeSlots(null, at("20:59:59"))).toEqual([
      "now",
      "30",
      "60",
      "120",
    ]);
    expect(generateTimeSlots(null, at("21:00:00"))).toEqual([
      "now",
      "30",
      "60",
      "120",
    ]);
    expect(generateTimeSlots(null, at("21:00:01"))).toEqual([
      "now",
      "30",
      "60",
    ]);
    expect(generateTimeSlots(null, at("22:30:00"))).toEqual(["now", "30"]);
    expect(generateTimeSlots(null, at("22:30:01"))).toEqual(["now"]);
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
