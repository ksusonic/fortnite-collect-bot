import type { Context } from "grammy";
import { GrammyError } from "grammy";
import { query, timestamp } from "../storage";
import { logEvent } from "../logging";

export const CONVERSATION_REACTIONS = [
  "🌚",
  "🗿",
  "🌭",
  "👀",
  "🤣",
  "🔥",
  "🤔",
  "🤝",
  "🏆",
  "🍌",
  "💯",
  "🤡",
] as const;
export type ConversationReaction = (typeof CONVERSATION_REACTIONS)[number];
export async function allowedReactions(
  ctx: Context,
): Promise<ConversationReaction[]> {
  try {
    const chat = await ctx.api.getChat(ctx.chat!.id);
    if (
      !("available_reactions" in chat) ||
      chat.available_reactions === undefined
    )
      return [...CONVERSATION_REACTIONS];
    return CONVERSATION_REACTIONS.filter((emoji) =>
      chat.available_reactions!.some(
        (r) => r.type === "emoji" && r.emoji === emoji,
      ),
    );
  } catch (error) {
    if (
      error instanceof GrammyError &&
      (error.error_code === 400 || error.error_code === 403)
    )
      return [];
    throw error;
  }
}
export async function reactToMessage(
  ctx: Context,
  id: number,
  emoji: ConversationReaction,
  thread: number,
  now: number,
): Promise<void> {
  try {
    await ctx.api.setMessageReaction(
      ctx.chat!.id,
      id,
      [{ type: "emoji", emoji }],
      { is_big: false },
    );
    await query(
      `INSERT INTO conversation_state(chat_id,thread_id,reacted_at) VALUES($1,$2,$3)
      ON CONFLICT(chat_id,thread_id) DO UPDATE SET reacted_at=excluded.reacted_at`,
      [ctx.chat!.id, thread, timestamp(now)],
    );
    logEvent("info", "conversation.reacted");
  } catch (error) {
    // Missing messages, forbidden reactions and revoked permissions are nonessential.
    if (
      !(error instanceof GrammyError) ||
      ![400, 403].includes(error.error_code)
    )
      throw error;
    logEvent("info", "conversation.reaction_rejected", {
      status: String(error.error_code),
    });
  }
}
