import "server-only";
import type { Api } from "grammy";
import { HttpError } from "../bot/http";
import { raw } from "../bot/storage";
import type { Viewer } from "./auth";
import { chatHint } from "./auth";

export async function verifyMembership(
  api: Pick<Api, "getMe" | "getChatMember" | "getChat">,
  chat: number,
  viewer: number,
) {
  try {
    const me = await api.getMe();
    const bot = await api.getChatMember(chat, me.id);
    if (bot.status !== "administrator" && bot.status !== "creator")
      throw new HttpError(
        403,
        "Для доступа бот должен быть администратором чата.",
      );
    const member = await api.getChatMember(chat, viewer);
    if (
      !["creator", "administrator", "member"].includes(member.status) &&
      !(member.status === "restricted" && member.is_member)
    )
      throw new HttpError(403, "Ты больше не участник этого чата.");
    const info = await api.getChat(chat);
    if (info.type !== "group" && info.type !== "supergroup")
      throw new HttpError(403, "Статистика доступна только для групп.");
    return { id: chat, title: info.title };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      "Не удалось проверить участие в чате. Попробуй позже.",
    );
  }
}
export async function knownChat(chat: number) {
  return !!(
    await raw("SELECT 1 FROM sessions WHERE chat_id=$1 LIMIT 1", [chat])
  ).rowCount;
}
export async function authorizeChat(
  api: Pick<Api, "getMe" | "getChatMember" | "getChat">,
  chat: number,
  viewer: number,
) {
  if (!Number.isSafeInteger(chat) || chat >= 0 || !(await knownChat(chat)))
    throw new HttpError(403, "Чат недоступен.");
  return verifyMembership(api, chat, viewer);
}
export async function discoverChats(
  api: Pick<Api, "getMe" | "getChatMember" | "getChat">,
  viewer: Viewer,
) {
  const rows = (
    await raw<{ chat_id: number }>(
      `SELECT chat_id FROM responses WHERE user_id=$1 AND NOT is_bot
 UNION SELECT chat_id FROM sessions WHERE initiator_id=$1`,
      [viewer.id],
    )
  ).rows;
  const hint = chatHint(viewer.startParam);
  if (
    hint !== null &&
    !rows.some((r) => r.chat_id === hint) &&
    (await knownChat(hint))
  )
    rows.unshift({ chat_id: hint });
  const chats = [];
  let unavailable = 0;
  // Bounded discovery. The launch-selected group is always checked first.
  rows.sort((a, b) =>
    a.chat_id === hint ? -1 : b.chat_id === hint ? 1 : a.chat_id - b.chat_id,
  );
  for (const row of rows.slice(0, 30)) {
    try {
      chats.push(await verifyMembership(api, row.chat_id, viewer.id));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.status === 503) unavailable++;
    }
  }
  return {
    chats,
    selected: chats.find((c) => c.id === hint)?.id ?? chats[0]?.id ?? null,
    viewerId: viewer.id,
    unavailable,
  };
}
