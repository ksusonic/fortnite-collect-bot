import type { InlineKeyboardMarkup } from "grammy/types";
/** Direct-link URL buttons work in groups; web_app buttons require private chats. */
export function statisticsKeyboard(
  chat: number,
): InlineKeyboardMarkup | undefined {
  const configured = process.env.MINI_APP_DIRECT_URL;
  if (!configured) return undefined;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "t.me" ||
    !Number.isSafeInteger(chat) ||
    chat >= 0
  )
    return undefined;
  url.searchParams.set("startapp", `chat_${Math.abs(chat)}`);
  return {
    inline_keyboard: [[{ text: "📊 Открыть статистику", url: url.toString() }]],
  };
}
