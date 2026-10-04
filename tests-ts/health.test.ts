import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  checkDatabase: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("../src/bot/readiness", () => ({ checkDatabase: mocks.checkDatabase }));
vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
  flush: mocks.flush,
}));
import { GET } from "../src/app/health/route";

describe("database-backed health", () => {
  beforeEach(() => vi.resetAllMocks());
  it("reports success only after live schema verification and prevents caching", async () => {
    const response = await GET();
    expect(mocks.checkDatabase).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });
  it("reports database failure without exposing SQL or credentials", async () => {
    const error = Object.assign(
      new Error('relation "approved_chats" does not exist; private SQL'),
      { code: "42P01" },
    );
    mocks.checkDatabase.mockRejectedValue(error);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: "processing incomplete" });
    expect(mocks.captureException).toHaveBeenCalledWith(error, {
      tags: {
        component: "http",
        error_code: "42P01",
        database_relation: "approved_chats",
      },
    });
  });
});
