import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import type { Message, User } from "grammy/types";
import * as db from "../src/bot/db";
import { cmdAfk } from "../src/bot/handlers/settings";

vi.mock("../src/bot/db", () => ({
  set_afk: vi.fn(),
  clear_afk: vi.fn(),
  resolve_user_by_username: vi.fn(),
}));
vi.mock("../src/bot/work", () => ({
  valueCheckpoint: async (_name: string, factory: () => unknown) => factory(),
}));

const caller: User = { id: 1, is_bot: false, first_name: "Caller" };
const other: User = { id: 2, is_bot: false, first_name: "<Other & friend>" };
function context(arg: string, user?: User): Context {
  return {
    chat: { id: -100, type: "supergroup", title: "Friends" },
    from: caller,
    match: arg,
    message: user
      ? {
          reply_to_message: {
            message_id: 10,
            date: 1,
            chat: { id: -100, type: "supergroup", title: "Friends" },
            from: user,
          },
        }
      : {},
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it.each([
  ["1d", 86400],
  ["2W", 1209600],
] as const)("preserves self AFK for %s", async (arg, seconds) => {
  const ctx = context(arg);
  await cmdAfk(ctx);
  expect(db.set_afk).toHaveBeenCalledWith(-100, 1, Date.now() / 1000 + seconds);
  expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("тебя"));
});
it("clears self AFK", async () => {
  await cmdAfk(context("off"));
  expect(db.clear_afk).toHaveBeenCalledWith(-100, 1);
});
it.each(["1d", "off"])("targets usernames for %s", async (arg) => {
  vi.mocked(db.resolve_user_by_username).mockResolvedValue([2, "@Other"]);
  const ctx = context(`@Other ${arg}`);
  await cmdAfk(ctx);
  expect(db.resolve_user_by_username).toHaveBeenCalledWith(-100, "@Other");
  if (arg === "off") expect(db.clear_afk).toHaveBeenCalledWith(-100, 2);
  else
    expect(db.set_afk).toHaveBeenCalledWith(-100, 2, Date.now() / 1000 + 86400);
  expect(ctx.reply).toHaveBeenCalledWith(
    expect.stringContaining("tg://user?id=2"),
  );
});
it.each(["1d", "off"])("targets replies for %s", async (arg) => {
  const ctx = context(arg, other);
  await cmdAfk(ctx);
  if (arg === "off") expect(db.clear_afk).toHaveBeenCalledWith(-100, 2);
  else
    expect(db.set_afk).toHaveBeenCalledWith(-100, 2, Date.now() / 1000 + 86400);
  expect(ctx.reply).toHaveBeenCalledWith(
    expect.stringContaining("&lt;Other &amp; friend&gt;"),
  );
  expect(db.resolve_user_by_username).not.toHaveBeenCalled();
});
it("prefers an explicit username over a reply", async () => {
  vi.mocked(db.resolve_user_by_username).mockResolvedValue([3, "@Third"]);
  await cmdAfk(context("@Third off", other));
  expect(db.clear_afk).toHaveBeenCalledWith(-100, 3);
});
it("does not fall back to self for unknown usernames", async () => {
  vi.mocked(db.resolve_user_by_username).mockResolvedValue(null);
  await cmdAfk(context("@Missing 1d"));
  expect(db.set_afk).not.toHaveBeenCalled();
  expect(db.clear_afk).not.toHaveBeenCalled();
});
it.each([
  "",
  "0d",
  "-1d",
  "10000d",
  "1h",
  "1d extra",
  "@ 1d",
  "@Other",
  "@Other off extra",
  "@<other> 1d",
])("rejects invalid arguments %s", async (arg) => {
  await cmdAfk(context(arg));
  expect(db.set_afk).not.toHaveBeenCalled();
  expect(db.clear_afk).not.toHaveBeenCalled();
  expect(db.resolve_user_by_username).not.toHaveBeenCalled();
});
it("rejects replies to bots", async () => {
  await cmdAfk(context("off", { ...other, is_bot: true }));
  expect(db.clear_afk).not.toHaveBeenCalled();
});
it("rejects replies sent on behalf of channels", async () => {
  const ctx = context("1d", other);
  ctx.message!.reply_to_message!.sender_chat = {
    id: -200,
    type: "channel",
    title: "Channel",
  };
  await cmdAfk(ctx);
  expect(db.set_afk).not.toHaveBeenCalled();
});
it("rejects replies without a sender", async () => {
  const ctx = context("1d", other);
  delete ctx.message!.reply_to_message!.from;
  await cmdAfk(ctx);
  expect(db.set_afk).not.toHaveBeenCalled();
});
it("ignores commands sent on behalf of a channel", async () => {
  const ctx = context("off");
  (ctx.message as Message).sender_chat = {
    id: -100,
    type: "supergroup",
    title: "Friends",
  };
  await cmdAfk(ctx);
  expect(db.clear_afk).not.toHaveBeenCalled();
});

it.each(["Other", "@Other", "`Other`", "`@Other`"])(
  "accepts username form %s",
  async (name) => {
    vi.mocked(db.resolve_user_by_username).mockResolvedValue([2, "@Other"]);
    await cmdAfk(context(`${name} 1d`));
    expect(db.resolve_user_by_username).toHaveBeenCalledWith(-100, "@Other");
    expect(db.set_afk).toHaveBeenCalledWith(-100, 2, Date.now() / 1000 + 86400);
  },
);
