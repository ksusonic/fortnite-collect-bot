import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  interpretGatheringMessage,
  validateGatheringIntent,
} from "../src/bot/gathering-intent";
const mocks = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn() }));
vi.mock("@vercel/connect", () => ({ getToken: mocks.token }));
vi.mock("../src/bot/transport", () => ({ scopedFetch: mocks.fetch }));
const now = Date.parse("2026-10-21T16:00:00+03:00") / 1000;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockResolvedValue("test-token");
});
describe("bounded Grok gathering classification", () => {
  it("uses the existing app connector, passes bounded context and validates a decision", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "set_time",
                  time: "через 20 минут",
                  confirm: false,
                  rejoin: false,
                }),
              },
            },
          ],
        }),
      ),
    );
    expect(
      await interpretGatheringMessage({
        text: "буду через двадцать минут",
        reply: "x".repeat(2000),
        now,
        participating: true,
        passed: false,
      }),
    ).toEqual({
      action: "set_time",
      at: now + 1200,
      confirm: false,
      rejoin: false,
    });
    expect(mocks.token).toHaveBeenCalledWith("grok/fortnite-collect-bot", {
      subject: { type: "app" },
    });
    const body = JSON.parse(mocks.fetch.mock.calls[0]![1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(JSON.parse(body.messages[1].content)).toMatchObject({
      moscow_time: "16:00",
      date: "2026-10-21",
      reply: "x".repeat(1000),
    });
    expect(body.messages[0].content).toContain("«ещё не зашёл»");
  });
  it.each([
    null,
    { action: "set_time", time: "25:99", confirm: false, rejoin: false },
    { action: "ready", confirm: "yes", rejoin: false },
    { action: "set_time", time: null, confirm: false, rejoin: false },
    { action: "delete_everyone", confirm: false, rejoin: false },
  ])("rejects malformed or unsupported decisions: %j", (input) => {
    expect(validateGatheringIntent(input, now)).toBeNull();
  });
  it("fails closed on provider errors, malformed JSON and missing credentials", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    const input = { text: "зашёл", now, participating: true, passed: false };
    expect(await interpretGatheringMessage(input)).toBeNull();
    mocks.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
      ),
    );
    expect(await interpretGatheringMessage(input)).toBeNull();
    mocks.token.mockRejectedValueOnce(new Error("missing"));
    expect(await interpretGatheringMessage(input)).toBeNull();
  });
});
