import { createServer } from "node:http";
import { Bot, HttpError, type ApiClientOptions } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { initializeBot } from "../src/bot/runtime";
import { scopedFetch, withHttpClient } from "../src/bot/transport";
import { telegramTransformer } from "../src/bot/work";

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
  it("uses the real SDK transport with a compatible dispatcher", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: info }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing port");
      const bot = new Bot("123456:test", {
        client: {
          apiRoot: `http://127.0.0.1:${address.port}`,
          fetch: scopedFetch as unknown as ApiClientOptions["fetch"],
          timeoutSeconds: 2,
        },
      });
      bot.api.config.use(telegramTransformer);
      await withHttpClient(() => initializeBot(bot), AbortSignal.timeout(3000));
      expect(bot.botInfo).toEqual(info);
      expect(requests).toEqual(["/bot123456:test/getMe"]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
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
