import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  processUpdate: vi.fn(),
  runJob: vi.fn(),
  registerWebhook: vi.fn(),
}));
vi.mock("../src/bot/runtime", () => ({
  processUpdate: mock.processUpdate,
  validateUpdate: (payload: unknown) => {
    if (!payload || typeof payload !== "object" || !("update_id" in payload))
      throw new Error("invalid");
  },
}));
vi.mock("../src/bot/jobs", () => ({
  JOB_PERIODS: {
    maintenance: 60,
    expiry: 60,
    status: 180,
    weekly: 300,
    cleanup: 86400,
  },
  runJob: mock.runJob,
}));
vi.mock("../src/bot/webhook", () => ({
  registerWebhook: mock.registerWebhook,
}));
import { POST as webhook } from "../src/app/api/telegram/webhook/route";
import { POST as job } from "../src/app/api/jobs/[name]/route";
import { POST as register } from "../src/app/api/admin/register-webhook/route";
describe("authenticated Next.js routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-webhook");
    vi.stubEnv("CRON_SECRET", "test-cron");
    vi.stubEnv("PUBLIC_BASE_URL", "https://bot.example");
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = (
    path: string,
    body: string = "{}",
    headers: Record<string, string> = {},
  ) =>
    new Request(`https://bot.example${path}`, {
      method: "POST",
      body,
      headers,
    });
  it("rejects webhook before processing an update", async () => {
    expect(
      (await webhook(request("/api/telegram/webhook", '{"update_id":1}')))
        .status,
    ).toBe(401);
    expect(mock.processUpdate).not.toHaveBeenCalled();
  });
  it("rejects malformed webhook JSON", async () => {
    expect(
      (
        await webhook(
          request("/api/telegram/webhook", "{", {
            "x-telegram-bot-api-secret-token": "test-webhook",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("acknowledges durable completion, quarantines uncertainty and retries incomplete work", async () => {
    for (const [outcome, status, expected] of [
      ["complete", 200, { ok: true }],
      ["ambiguous", 200, { ok: true, review_required: true }],
      ["failed", 503, { detail: "processing incomplete" }],
    ] as const) {
      mock.processUpdate.mockResolvedValue(outcome);
      const response = await webhook(
        request("/api/telegram/webhook", '{"update_id":1}', {
          "x-telegram-bot-api-secret-token": "test-webhook",
        }),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(expected);
    }
  });
  it("authenticates jobs and rejects unknown names before dispatch", async () => {
    const params = Promise.resolve({ name: "weekly" });
    expect((await job(request("/api/jobs/weekly"), { params })).status).toBe(
      401,
    );
    expect(mock.runJob).not.toHaveBeenCalled();
    expect(
      (
        await job(
          request("/api/jobs/unknown", "{}", {
            authorization: "Bearer test-cron",
          }),
          { params: Promise.resolve({ name: "unknown" }) },
        )
      ).status,
    ).toBe(404);
    mock.runJob.mockResolvedValue({ ok: true });
    for (const name of [
      "maintenance",
      "expiry",
      "status",
      "weekly",
      "cleanup",
    ]) {
      expect(
        (
          await job(
            request(`/api/jobs/${name}`, "{}", {
              authorization: "Bearer test-cron",
            }),
            { params: Promise.resolve({ name }) },
          )
        ).status,
      ).toBe(200);
      expect(mock.runJob).toHaveBeenCalledWith(name, expect.any(AbortSignal));
    }
  });
  it("registers a webhook only through an explicit authenticated operation", async () => {
    expect(
      (await register(request("/api/admin/register-webhook"))).status,
    ).toBe(401);
    expect(mock.registerWebhook).not.toHaveBeenCalled();
    mock.registerWebhook.mockResolvedValue({
      url: "https://bot.example/api/telegram/webhook",
    });
    expect(
      (
        await register(
          request("/api/admin/register-webhook", "{}", {
            authorization: "Bearer test-cron",
          }),
        )
      ).status,
    ).toBe(200);
    expect(mock.registerWebhook).toHaveBeenCalledWith("https://bot.example");
  });
});
