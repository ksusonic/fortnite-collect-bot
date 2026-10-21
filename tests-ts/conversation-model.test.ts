import { expect, it } from "vitest";
import {
  parseIntent,
  parseConversationDecision,
  parseExtractedFacts,
} from "../src/bot/services/conversation-model";
import { addressedByName, messageLink } from "../src/bot/handlers/roast";
import type { Source } from "../src/bot/services/conversation-store";
const sources: Source[] = [
  {
    ref: "s:42",
    message_id: 42,
    user_id: 7,
    name: "Даня",
    text: "Обычно после девяти",
    ts: 100,
    thread_id: 0,
  },
];
it("rejects invented sources, cross-scope IDs and invalid mutations", () => {
  const parse = (
    value: unknown,
    addressed = true,
    op: "reply" | "remember" | "forget" = "reply",
  ) => parseConversationDecision(value, sources, addressed, op, 1000);
  expect(
    parse({ action: "reply", text: "В девять", sources: ["s:99"] }),
  ).toBeNull();
  expect(
    parse({ action: "reply", text: "В девять", reply_ref: "m:1", sources: [] }),
  ).toBeNull();
  expect(
    parse(
      { action: "forget", text: "Ок", source_ref: "s:42" },
      false,
      "forget",
    ),
  ).toBeNull();
  expect(
    parse({ action: "forget", text: "Ок", source_ref: "s:42" }, true, "reply"),
  ).toBeNull();
  expect(
    parse(
      {
        action: "remember",
        text: "Ок",
        source_ref: "s:42",
        content: "Факт",
        expires_at: 999,
      },
      true,
      "remember",
    ),
  ).toBeNull();
  expect(
    parse({ action: "update", text: "Ок", patch: { model: "other" } }),
  ).toBeNull();
  expect(
    parse({
      action: "reply",
      text: "В девять",
      reply_ref: "s:42",
      sources: ["s:42"],
    }),
  ).toMatchObject({ reply_ref: "s:42" });
});
it("accepts moon, moyai and hot dog reactions, rejects arbitrary emoji and IDs", () => {
  for (const emoji of ["🌚", "🗿", "🌭"])
    expect(
      parseConversationDecision(
        { action: "react", emoji, source_ref: "s:42" },
        sources,
        false,
        "reply",
        1000,
      ),
    ).toEqual({ action: "react", emoji, source_ref: "s:42" });
  for (const value of [
    { action: "react", emoji: "🚀", source_ref: "s:42" },
    { action: "react", emoji: "🗿", source_ref: "s:999" },
  ])
    expect(
      parseConversationDecision(value, sources, false, "reply", 1000),
    ).toBeNull();
});
it("bounds search formulations and accepts author filters without inventing user identities", () => {
  expect(
    parseIntent(
      {
        addressed: true,
        operation: "reply",
        search: { queries: ["смогу", "после"], author: "Даня" },
      },
      sources,
      8,
    ),
  ).toMatchObject({ search: { author: "Даня" } });
  expect(
    parseIntent(
      {
        addressed: true,
        operation: "reply",
        search: { queries: [], user_id: 999 },
      },
      sources,
      8,
    ),
  ).toBeNull();
  expect(
    parseIntent(
      {
        addressed: true,
        operation: "reply",
        search: { queries: ["a", "b", "c", "d"] },
      },
      sources,
      8,
    ),
  ).toBeNull();
  expect(
    parseIntent(
      {
        addressed: true,
        operation: "reply",
        search: { queries: [], after: 200, before: 100 },
      },
      sources,
      8,
    ),
  ).toBeNull();
});
it("extracts only sourced facts with usable expiration dates", () => {
  expect(
    parseExtractedFacts(
      {
        facts: [
          { source_ref: "s:42", content: "После девяти", expires_at: null },
          { source_ref: "s:99", content: "Неверно", expires_at: null },
          { source_ref: "s:42", content: "Уже было", expires_at: 10 },
        ],
      },
      sources,
      1000,
    ),
  ).toEqual([
    { source_ref: "s:42", content: "После девяти", expires_at: null },
  ]);
});
it("recognizes names at the start and builds only valid Telegram message links", () => {
  expect(addressedByName("Грок, а почему?", "Fort", "fort_bot")).toBe(true);
  expect(addressedByName("эй Грок расскажи", "Fort", "fort_bot")).toBe(true);
  expect(addressedByName("мой друг Грок", "Fort", "fort_bot")).toBe(false);
  expect(messageLink(-10012345, "supergroup", undefined, 42)).toBe(
    "https://t.me/c/12345/42",
  );
  expect(messageLink(-10012345, "supergroup", "friends", 42)).toBe(
    "https://t.me/friends/42",
  );
  expect(messageLink(-123, "group", undefined, 42)).toBeNull();
  expect(messageLink(-10012345, "supergroup", undefined, -1)).toBeNull();
});

it("rejects impossible dates and remembering forwarded claims", () => {
  expect(
    parseIntent(
      {
        addressed: true,
        operation: "reply",
        search: { queries: [], after: 1e100 },
      },
      sources,
      7,
    ),
  ).toBeNull();
  expect(
    parseConversationDecision(
      {
        action: "remember",
        text: "Ок",
        source_ref: "s:42",
        content: "факт",
        expires_at: 1e100,
      },
      sources,
      true,
      "remember",
      1000,
    ),
  ).toBeNull();
  expect(
    parseConversationDecision(
      {
        action: "remember",
        text: "Ок",
        source_ref: "s:42",
        content: "факт",
        expires_at: null,
      },
      sources.map((s) => ({ ...s, forwarded: true })),
      true,
      "remember",
      1000,
    ),
  ).toBeNull();
});
