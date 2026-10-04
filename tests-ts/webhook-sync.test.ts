import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "grammy";

const mock = vi.hoisted(() => ({ raw: vi.fn() }));
vi.mock("../src/bot/storage", () => ({ raw: mock.raw }));
import { ensureStartupWebhook, syncReleaseWebhook } from "../src/bot/webhook";

const url = "https://fortnite.example/api/telegram/webhook";

function bot() {
  const api = {
    getWebhookInfo: vi.fn().mockResolvedValue({ url: "" }),
    setWebhook: vi.fn().mockResolvedValue(true),
  };
  api.setWebhook.mockImplementation(async () => {
    api.getWebhookInfo.mockResolvedValue({
      url,
      max_connections: 1,
      allowed_updates: ["message", "callback_query"],
    });
    return true;
  });
  return { api };
}

beforeEach(() => {
  vi.stubEnv("PUBLIC_BASE_URL", "https://fortnite.example");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
  mock.raw.mockReset().mockResolvedValue({ rows: [] });
});
afterEach(() => vi.unstubAllEnvs());

it("sets and verifies the production webhook before recording the release", async () => {
  const instance = bot();
  await syncReleaseWebhook(instance as unknown as Bot);
  expect(instance.api.setWebhook).toHaveBeenCalledWith(url, {
    secret_token: "test-secret",
    max_connections: 1,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  const marker = JSON.parse(mock.raw.mock.calls[1]![1][0]);
  mock.raw.mockResolvedValue({ rows: [{ value: marker }] });
  await syncReleaseWebhook(instance as unknown as Bot);
  expect(instance.api.setWebhook).toHaveBeenCalledTimes(1);
  instance.api.getWebhookInfo.mockResolvedValueOnce({ url: "" });
  await syncReleaseWebhook(instance as unknown as Bot);
  expect(instance.api.setWebhook).toHaveBeenCalledTimes(2);
});

it("does not record a release when Telegram readback disagrees", async () => {
  const instance = bot();
  instance.api.setWebhook.mockResolvedValue(true);
  await expect(syncReleaseWebhook(instance as unknown as Bot)).rejects.toThrow(
    "verification failed",
  );
  expect(mock.raw.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});

it("checks the webhook at startup without using the database", async () => {
  const instance = bot();
  instance.api.getWebhookInfo.mockResolvedValue({
    url,
    max_connections: 1,
    allowed_updates: ["message", "callback_query"],
  });
  await ensureStartupWebhook(instance as unknown as Bot);
  expect(instance.api.setWebhook).not.toHaveBeenCalled();
  expect(mock.raw).not.toHaveBeenCalled();
});
