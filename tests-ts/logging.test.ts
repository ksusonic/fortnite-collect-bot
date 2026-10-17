import { afterEach, expect, it, vi } from "vitest";
import {
  logEvent,
  withRequestLogs,
  workReference,
  errorFields,
} from "../src/bot/logging";
afterEach(() => vi.restoreAllMocks());
it("isolates concurrent request correlation and excludes raw error contents", async () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  await Promise.all(
    ["webhook", "job"].map((operation) =>
      withRequestLogs(operation, async () => {
        logEvent("info", "started");
        await Promise.resolve();
        logEvent(
          "info",
          "completed",
          errorFields(new Error("Bearer secret private message")),
        );
      }),
    ),
  );
  const records = output.mock.calls.map(([line]) => JSON.parse(line as string));
  for (const operation of ["webhook", "job"]) {
    const ids = records
      .filter((record) => record.operation === operation)
      .map((record) => record.request_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  }
  expect(records[0].request_id).not.toBe(records[1].request_id);
  expect(JSON.stringify(records)).not.toMatch(/secret|private message/);
  expect(workReference("weekly:2026-10-17:-123456")).toMatch(/^[a-f0-9]{24}$/);
  expect(workReference("same")).toBe(workReference("same"));
  expect(workReference("same")).not.toBe(workReference("different"));
});

it("reports safe error classes and numeric Telegram codes without descriptions", () => {
  expect(errorFields(new TypeError("secret"))).toEqual({
    error_type: "TypeError",
    error_code: "unclassified",
  });
  expect(
    errorFields({ error_code: 429, description: "private message" }),
  ).toMatchObject({ telegram_error_code: "429" });
  const error = new Error("secret");
  error.name = "private name";
  expect(errorFields(error).error_type).toBe("Error");
});
