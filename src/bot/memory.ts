import "server-only";
import * as Sentry from "@sentry/nextjs";
import { httpSignal, scopedFetch } from "./transport";

// Both IDs are server-derived: a user's memories never cross group boundaries.
const identity = (chat: number, user: number) =>
  `telegram:${chat}:user:${user}`;

class Mem0HttpError extends Error {
  constructor(readonly status: number) {
    super("Mem0 request failed");
  }
}

function logMemoryError(operation: "search" | "add", error: unknown) {
  // Provider messages and response bodies can contain private conversation data.
  const kind =
    error instanceof Mem0HttpError
      ? "http"
      : error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : error instanceof Error && error.name === "AbortError"
          ? "aborted"
          : error instanceof SyntaxError || error instanceof TypeError
            ? "invalid-response-or-transport"
            : "unknown";
  const details = {
    operation,
    kind,
    ...(error instanceof Mem0HttpError ? { status: error.status } : {}),
  };
  console.error("Mem0 operation failed", details);
  Sentry.logger.error("Mem0 operation failed", details);
}

async function client(operation: "search" | "add") {
  const apiKey = process.env.MEM0_API_KEY?.trim();
  if (!apiKey) {
    Sentry.logger.warn("Mem0 disabled: missing API key", { operation });
    return null;
  }
  // The SDK otherwise starts detached telemetry fetches during construction.
  process.env.MEM0_TELEMETRY = "false";
  const { default: MemoryClient } = await import("mem0ai");
  class ScopedMemoryClient extends MemoryClient {
    // Authenticate on the awaited search/add request, without a background ping.
    override async ping(): Promise<void> {}
    override async _fetchRawJson(
      url: string,
      options: RequestInit,
    ): Promise<unknown> {
      const response = await scopedFetch(url, {
        ...options,
        headers: { ...this.headers },
        signal: httpSignal(5000),
      });
      if (!response.ok) throw new Mem0HttpError(response.status);
      return response.json();
    }
  }
  return new ScopedMemoryClient({ apiKey });
}

export async function searchMemories(
  chat: number,
  user: number,
  query: string,
): Promise<string[]> {
  try {
    Sentry.logger.info("Mem0 operation started", { operation: "search" });
    const memory = await client("search");
    if (!memory) return [];
    const result = await memory.search(query.slice(0, 4096), {
      filters: { user_id: identity(chat, user) },
      topK: 5,
    });
    return result.results
      .filter((entry) => typeof entry.memory === "string")
      .slice(0, 5)
      .map((entry) => entry.memory!.slice(0, 500));
  } catch (error) {
    logMemoryError("search", error);
    return [];
  }
}

export async function storeMemoryTurn(
  chat: number,
  user: number,
  message: string,
  reply: string,
  messageId: number,
): Promise<boolean> {
  try {
    Sentry.logger.info("Mem0 operation started", { operation: "add" });
    const memory = await client("add");
    if (!memory) return false;
    await memory.add(
      [
        { role: "user", content: message.slice(0, 4096) },
        { role: "assistant", content: reply.slice(0, 4096) },
      ],
      {
        userId: identity(chat, user),
        metadata: { source: "telegram", message_id: messageId },
        customInstructions:
          "Remember only explicit user facts and preferences useful for future conversation. " +
          "Do not treat jokes, insults, assistant claims or speculation about other people as facts.",
      },
    );
    return true;
  } catch (error) {
    logMemoryError("add", error);
    return false;
  }
}
