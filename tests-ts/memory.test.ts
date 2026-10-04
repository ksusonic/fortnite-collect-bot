import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  confirmMemoryTurn,
  searchMemories,
  storeMemoryTurn,
} from "../src/bot/memory";

const eventId = "3c90c3cc-0d44-4b50-8888-8dd25736052a";

const request = vi.hoisted(() => vi.fn());
const sentryLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
let errorLog: ReturnType<typeof vi.spyOn>;
vi.mock("@sentry/nextjs", () => ({ logger: sentryLog }));
vi.mock("../src/bot/transport", () => ({
  scopedFetch: request,
  httpSignal: () => new AbortController().signal,
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  request.mockReset();
  vi.clearAllMocks();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

it("does not call Mem0 when the optional key is absent", async () => {
  vi.stubEnv("MEM0_API_KEY", "");
  expect(await searchMemories(-100, 7, "hi")).toEqual([]);
  expect(await storeMemoryTurn(-100, 7, "hi", "reply", 1)).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(errorLog).not.toHaveBeenCalled();
  expect(sentryLog.warn).toHaveBeenCalledWith(
    "Mem0 disabled: missing API key",
    { operation: "search" },
  );
});

it("uses the SDK envelope and isolates chat and user identities", async () => {
  vi.stubEnv("MEM0_API_KEY", "test-key");
  request.mockImplementation(async () =>
    Response.json({ results: [{ memory: "Likes squads" }, {}] }),
  );
  expect(await searchMemories(-100, 7, "play?")).toEqual(["Likes squads"]);
  await searchMemories(-200, 7, "play?");
  await searchMemories(-100, 8, "play?");
  expect(
    request.mock.calls.map((call) => JSON.parse(call[1].body).filters),
  ).toEqual([
    { user_id: "telegram:-100:user:7" },
    { user_id: "telegram:-200:user:7" },
    { user_id: "telegram:-100:user:8" },
  ]);
  expect(request.mock.calls[0][0]).toBe(
    "https://api.mem0.ai/v3/memories/search/",
  );
  expect(request.mock.calls[0][1].headers.Authorization).toBe("Token test-key");
  expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  expect(process.env.MEM0_TELEMETRY).toBe("false");
});

it("stores both turns under the same scope with message metadata", async () => {
  vi.stubEnv("MEM0_API_KEY", "test-key");
  request.mockResolvedValue(
    Response.json({ status: "PENDING", event_id: eventId }),
  );
  expect(await storeMemoryTurn(-100, 7, "play?", "yes", 42)).toEqual({
    eventId,
  });
  expect(request.mock.calls[0][0]).toBe("https://api.mem0.ai/v3/memories/add/");
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
    user_id: "telegram:-100:user:7",
    messages: [
      { role: "user", content: "play?" },
      { role: "assistant", content: "yes" },
    ],
    metadata: { source: "telegram", message_id: 42 },
  });
});

it.each(["unavailable", "timeout", "invalid-response"])(
  "degrades %s without exposing credentials or chat text",
  async (failure) => {
    vi.stubEnv("MEM0_API_KEY", "test-key");
    if (failure === "unavailable")
      request.mockImplementation(
        async () => new Response("secret", { status: 503 }),
      );
    else if (failure === "timeout")
      request.mockRejectedValue(new DOMException("secret", "TimeoutError"));
    else
      request.mockImplementation(async () => Response.json({ invalid: true }));
    expect(await searchMemories(-100, 7, "private text")).toEqual([]);
    if (failure !== "invalid-response")
      expect(
        await storeMemoryTurn(-100, 7, "private text", "reply", 1),
      ).toBeNull();
    expect(errorLog).toHaveBeenCalledWith("Mem0 operation failed", {
      operation: "search",
      kind:
        failure === "unavailable"
          ? "http"
          : failure === "timeout"
            ? "timeout"
            : "invalid-response-or-transport",
      ...(failure === "unavailable" ? { status: 503 } : {}),
    });
    expect(sentryLog.error).toHaveBeenCalledWith("Mem0 operation failed", {
      operation: "search",
      kind:
        failure === "unavailable"
          ? "http"
          : failure === "timeout"
            ? "timeout"
            : "invalid-response-or-transport",
      ...(failure === "unavailable" ? { status: 503 } : {}),
    });
    if (failure !== "invalid-response")
      expect(errorLog).toHaveBeenCalledWith(
        "Mem0 operation failed",
        expect.objectContaining({ operation: "add" }),
      );
    const logs = JSON.stringify([
      errorLog.mock.calls,
      sentryLog.error.mock.calls,
    ]);
    for (const sensitive of ["secret", "test-key", "private text", "reply"])
      expect(logs).not.toContain(sensitive);
  },
);

it("bounds memory context even if the provider ignores topK", async () => {
  vi.stubEnv("MEM0_API_KEY", "test-key");
  request.mockResolvedValue(
    Response.json({
      results: Array.from({ length: 10 }, () => ({ memory: "x".repeat(1000) })),
    }),
  );
  const memories = await searchMemories(-100, 7, "hi");
  expect(memories).toHaveLength(5);
  expect(memories.every((memory) => memory.length === 500)).toBe(true);
});

it.each([
  [{ status: "SUCCEEDED", results: [{ id: "one" }] }, "saved"],
  [{ status: "SUCCEEDED", results: [] }, "empty"],
  [{ status: "FAILED", results: [] }, "failed"],
] as const)("confirms the actual Mem0 outcome", async (event, outcome) => {
  vi.stubEnv("MEM0_API_KEY", "test-key");
  request.mockResolvedValue(Response.json(event));
  expect(await confirmMemoryTurn(eventId)).toBe(outcome);
  expect(request.mock.calls[0][0]).toBe(
    `https://api.mem0.ai/v1/event/${eventId}/`,
  );
  expect(request.mock.calls[0][1].headers.Authorization).toBe("Token test-key");
});

it("does not interpret an invalid add response as a completed write", async () => {
  vi.stubEnv("MEM0_API_KEY", "test-key");
  request.mockResolvedValue(Response.json({ status: "PENDING" }));
  expect(await storeMemoryTurn(-100, 7, "private text", "reply", 1)).toBeNull();
  expect(sentryLog.error).toHaveBeenCalledWith("Mem0 operation failed", {
    operation: "add",
    kind: "invalid-response-or-transport",
  });
});

it("leaves a still-running event unconfirmed after bounded checks", async () => {
  vi.stubEnv("MEM0_API_KEY", "test-key");
  vi.useFakeTimers();
  try {
    request.mockImplementation(async () => Response.json({ status: "RUNNING" }));
    const outcome = confirmMemoryTurn(eventId);
    await vi.runAllTimersAsync();
    expect(await outcome).toBe("pending");
    expect(request).toHaveBeenCalledTimes(6);
    expect(sentryLog.warn).toHaveBeenCalledWith("Mem0 write unconfirmed", {
      operation: "confirm",
    });
  } finally {
    vi.useRealTimers();
  }
});
