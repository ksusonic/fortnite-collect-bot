import type { Update } from "grammy/types";
import { query, raw } from "../storage";

export function isGeneralAdmin(id: number | undefined): boolean {
  const admin = Number(process.env.ADMIN_USER_ID);
  return Number.isSafeInteger(admin) && admin > 0 && id === admin;
}
export function isOwnerInit(update: Update): boolean {
  const message = update.message;
  return (
    !!message &&
    ["group", "supergroup"].includes(message.chat.type) &&
    !message.sender_chat &&
    !message.from?.is_bot &&
    isGeneralAdmin(message.from?.id) &&
    !!message.text &&
    /^\/init(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(message.text) &&
    !!message.entities?.some(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    )
  );
}
/** Authorization is checked live, never replayed from an old read checkpoint. */
export async function isChatApproved(chat: number): Promise<boolean> {
  return !!(await raw("SELECT 1 FROM approved_chats WHERE chat_id=$1", [chat]))
    .rows.length;
}
export async function approveChat(chat: number, admin: number): Promise<void> {
  if (!isGeneralAdmin(admin))
    throw new Error("chat approval requires general admin");
  await query(
    "INSERT INTO approved_chats(chat_id,approved_by) VALUES ($1,$2) ON CONFLICT(chat_id) DO NOTHING",
    [chat, admin],
  );
}
