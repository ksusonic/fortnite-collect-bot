import "server-only";
import { httpSignal, scopedFetch } from "./transport";

// Both IDs are server-derived: a user's memories never cross group boundaries.
const identity = (chat: number, user: number) =>
  `telegram:${chat}:user:${user}`;

async function client() {
  const apiKey = process.env.MEM0_API_KEY?.trim();
  if (!apiKey) return null;
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
      if (!response.ok) throw new Error("Mem0 request failed");
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
    const memory = await client();
    if (!memory) return [];
    const result = await memory.search(query.slice(0, 4096), {
      filters: { user_id: identity(chat, user) },
      topK: 5,
    });
    return result.results
      .filter((entry) => typeof entry.memory === "string")
      .slice(0, 5)
      .map((entry) => entry.memory!.slice(0, 500));
  } catch {
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
    const memory = await client();
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
  } catch {
    return false;
  }
}
