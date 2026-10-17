import { afterEach, expect, it, vi } from "vitest";
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
}));
import { endpoint, HttpError } from "../src/bot/http";
afterEach(() => vi.restoreAllMocks());
it("returns correlated responses for success, rejection and unexpected failure", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const results = [
    await endpoint(async () => ({ ok: true }), "test"),
    await endpoint(async () => {
      throw new HttpError(401, "unauthorized");
    }, "test"),
    await endpoint(async () => {
      throw new TypeError("Bearer secret private message");
    }, "test"),
  ];
  expect(results.map((result) => result.status)).toEqual([200, 401, 503]);
  const records = [
    ...info.mock.calls,
    ...warn.mock.calls,
    ...error.mock.calls,
  ].map(([line]) => JSON.parse(line as string));
  for (const response of results) {
    expect(response.headers.get("cache-control")).toBe("no-store");
    const id = response.headers.get("x-request-id");
    expect(id).toBeTruthy();
    expect(records.filter((record) => record.request_id === id)).toHaveLength(
      2,
    );
  }
  expect(
    new Set(results.map((result) => result.headers.get("x-request-id"))).size,
  ).toBe(3);
  expect(JSON.stringify(records)).not.toMatch(/secret|private message/);
  expect(await results[2].json()).toEqual({ detail: "processing incomplete" });
});
