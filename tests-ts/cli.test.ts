import * as undici from "undici";
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  migrate: vi.fn(),
  importer: vi.fn(),
  commands: vi.fn(),
  webhook: vi.fn(),
  info: vi.fn(),
  menu: vi.fn(),
}));
vi.mock("../src/bot/storage", () => ({ migrate: mocks.migrate }));
vi.mock("../src/bot/importer", () => ({ importBackup: mocks.importer }));
vi.mock("../src/bot/commands", () => ({ setupBotCommands: mocks.commands }));
vi.mock("../src/bot/runtime", () => ({
  createBot: () => ({
    api: {
      setWebhook: mocks.webhook,
      getWebhookInfo: mocks.info,
      setChatMenuButton: mocks.menu,
    },
  }),
}));
import { maintain } from "../src/bot/cli";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-webhook-secret");
  mocks.info.mockResolvedValue({
    url: "https://example.com/api/telegram/webhook",
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("explicit maintenance", () => {
  it("configures the Mini App menu explicitly after checking HTTPS page without touching webhook", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue(
      new undici.Response("Mini App", { status: 200 }),
    );
    await maintain(["configure-mini-app", "https://example.com"]);
    expect(mocks.menu).toHaveBeenCalledWith({
      menu_button: {
        type: "web_app",
        text: "Статистика",
        web_app: { url: "https://example.com/mini-app" },
      },
    });
    expect(mocks.webhook).not.toHaveBeenCalled();
    await expect(
      maintain(["configure-mini-app", "http://example.com"]),
    ).rejects.toThrow("HTTPS");
  });

  it("does not register a webhook during migration or import", async () => {
    await maintain(["migrate"]);
    await maintain(["import", "/readonly/backup.db"]);
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.importer).toHaveBeenCalledWith("/readonly/backup.db");
    expect(mocks.webhook).not.toHaveBeenCalled();
  });
  it("requires health success before changing menus or webhook", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue(
      undici.Response.json({ ok: false }),
    );
    await expect(
      maintain(["register-webhook", "https://example.com"]),
    ).rejects.toThrow("production health check failed");
    expect(mocks.commands).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
  });
  it("registers a stable secret webhook without dropping pending updates", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue(
      undici.Response.json({ ok: true }),
    );
    await maintain(["register-webhook", "https://example.com/"]);
    expect(mocks.commands).toHaveBeenCalledOnce();
    expect(mocks.webhook).toHaveBeenCalledWith(
      "https://example.com/api/telegram/webhook",
      {
        secret_token: "test-webhook-secret",
        max_connections: 1,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      },
    );
  });
  it("webhook-info is read-only", async () => {
    await maintain(["webhook-info"]);
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.webhook).not.toHaveBeenCalled();
  });
});
