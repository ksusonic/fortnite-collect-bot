import { expect, it } from "vitest";
import {
  DEFAULT_ROAST_POLICY,
  parseRoastDecision,
  parseRoastPolicy,
  proactiveDue,
} from "../src/bot/services/roast-policy";

it("rejects unknown preferences, bad types, and unauthorised context changes", () => {
  expect(
    parseRoastDecision(
      { action: "update", patch: { frequency: "rare" }, text: "Ок" },
      true,
    ),
  ).toEqual({ action: "update", patch: { frequency: "rare" }, text: "Ок" });
  for (const patch of [
    { model: "other" },
    { proactive: "false" },
    { frequency: "unlimited" },
    {},
  ])
    expect(
      parseRoastDecision({ action: "update", patch, text: "Ок" }, true),
    ).toBeNull();
  expect(
    parseRoastDecision(
      { action: "update", patch: { proactive: false }, text: "Ок" },
      false,
    ),
  ).toBeNull();
  expect(
    parseRoastDecision({ action: "clarify", text: "Короче или реже?" }, false),
  ).toBeNull();
  expect(parseRoastDecision({ action: "reply", text: "" }, true)).toBeNull();
  expect(
    parseRoastDecision({ action: "reply", text: "Ок", chat_id: 4 }, true),
  ).toBeNull();
});
it("validates the full remote policy and enforces minimum intervals", () => {
  expect(parseRoastPolicy(DEFAULT_ROAST_POLICY)).toEqual(DEFAULT_ROAST_POLICY);
  for (const bad of [
    null,
    { ...DEFAULT_ROAST_POLICY, defaults: {} },
    { ...DEFAULT_ROAST_POLICY, intervals: { rare: 10, normal: 5, active: 1 } },
    {
      ...DEFAULT_ROAST_POLICY,
      intervals: { rare: 300, normal: 600, active: 300 },
    },
  ])
    expect(parseRoastPolicy(bad)).toEqual(DEFAULT_ROAST_POLICY);
});
it("keeps new chats quiet and limits attempts, including silent decisions", () => {
  const policy = DEFAULT_ROAST_POLICY;
  expect(proactiveDue(policy, policy.defaults, null, 1000)).toBe(false);
  const prefs = { ...policy.defaults, proactive: true };
  expect(proactiveDue(policy, prefs, 1000, 1599)).toBe(false);
  expect(proactiveDue(policy, prefs, 1000, 1600)).toBe(true);
  expect(
    proactiveDue({ ...policy, proactiveAllowed: false }, prefs, null, 1600),
  ).toBe(false);
});
