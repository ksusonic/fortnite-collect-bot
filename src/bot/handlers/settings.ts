import type { Context } from "grammy";
import * as db from "../db";
import { valueCheckpoint } from "../work";
import { displayName, escapeHtml, mskDate, nowSeconds, reply } from "./common";

export async function cmdAfk(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from || ctx.message?.sender_chat || ctx.from.is_bot)
    return;
  const args = String(ctx.match ?? "")
    .trim()
    .split(/\s+/);
  const rawUsername = args.length > 1 ? args.shift() : undefined;
  const username = rawUsername?.replace(/^`([^`]+)`$/, "$1").replace(/^@/, "");
  const arg = (args[0] ?? "").toLowerCase();
  const match = /^([1-9]\d{0,3})([dw])$/.exec(arg);
  if (
    args.length !== 1 ||
    (rawUsername !== undefined && !/^[a-zA-Z0-9_]+$/.test(username ?? "")) ||
    (arg !== "off" && !match)
  ) {
    await reply(
      ctx,
      "Использование: /afk 1d, /afk 2w, /afk off; для другого участника: /afk @username 1d или ответь на его сообщение командой /afk 1d. Можно без @ или в обратных кавычках. Для отмены используй off.",
    );
    return;
  }
  let userId = ctx.from.id;
  let name = displayName(ctx.from);
  if (username) {
    const resolved = await db.resolve_user_by_username(
      ctx.chat.id,
      `@${username}`,
    );
    if (!resolved) {
      await reply(
        ctx,
        `Не нашёл ${escapeHtml(username)} среди тех, кто отвечал на /fort в этом чате. Ответь на сообщение участника командой /afk 1d.`,
      );
      return;
    }
    [userId, name] = resolved;
  } else if (ctx.message?.reply_to_message) {
    const message = ctx.message.reply_to_message;
    if (!message.from || message.from.is_bot || message.sender_chat) {
      await reply(ctx, "Ответь на сообщение участника, а не бота или канала.");
      return;
    }
    userId = message.from.id;
    name = displayName(message.from);
  }
  const target =
    userId === ctx.from.id
      ? "тебя"
      : `<a href="tg://user?id=${userId}">${escapeHtml(name)}</a>`;
  if (arg === "off") {
    await db.clear_afk(ctx.chat.id, userId);
    await reply(ctx, `Снова буду звать ${target} в новых /fort сборах.`);
    return;
  }
  if (!match) return;
  const until = await valueCheckpoint(
    "afk-until",
    () => nowSeconds() + Number(match[1]) * (match[2] === "w" ? 7 : 1) * 86400,
  );
  await db.set_afk(ctx.chat.id, userId, until);
  const date = mskDate(until);
  const pad = (value: number) => String(value).padStart(2, "0");
  await reply(
    ctx,
    `Не буду звать ${target} в новых /fort сборах до ${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} МСК.`,
  );
}
