import { Bot, HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { initializeBot } from "../src/bot/runtime";
import { withHttpClient } from "../src/bot/transport";

const info = {
  id: 123456,
  is_bot: true as const,
  first_name: "Test",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
describe("bounded Telegram initialization", () => {
  it("makes one attempt on retryable network failures", async () => {
    const bot = new Bot("123456:test");
    const error = new HttpError(
      "network failure",
      new Error("connection failed"),
    );
    const getMe = vi.spyOn(bot.api, "getMe").mockRejectedValue(error);
    await expect(initializeBot(bot)).rejects.toBe(error);
    expect(getMe).toHaveBeenCalledOnce();
    expect(getMe.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(bot.isInited()).toBe(false);
  });
  it("initializes once and respects the invocation's abort signal", async () => {
    const bot = new Bot("123456:test");
    const getMe = vi.spyOn(bot.api, "getMe").mockResolvedValue(info);
    const controller = new AbortController();
    await withHttpClient(() => initializeBot(bot), controller.signal);
    const signal = getMe.mock.calls[0][0]!;
    controller.abort();
    expect(signal.aborted).toBe(true);
    expect(bot.botInfo).toEqual(info);
    await initializeBot(bot);
    expect(getMe).toHaveBeenCalledOnce();
  });
});
