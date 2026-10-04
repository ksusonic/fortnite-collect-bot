import type { Context } from "grammy";
import * as db from "../db";
import * as roast from "../roast";
import { storeMemoryTurn } from "../memory";
import { getRoastState } from "../storage";
import { externalCheckpoint, valueCheckpoint } from "../work";
import { escapeHtml, isGroup, nowSeconds } from "./common";

export async function maybeRoast(ctx: Context): Promise<void> {
  if (
    !ctx.message?.text ||
    !ctx.from ||
    ctx.from.is_bot ||
    !ctx.chat ||
    !isGroup(ctx) ||
    ctx.message.text.startsWith("/")
  )
    return;
  const chat = ctx.chat.id,
    message = ctx.message,
    now = await valueCheckpoint("roast-history-time", nowSeconds);
  const name =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
    "Аноним";
  const replied = message.reply_to_message;
  roast.rememberMessage(
    chat,
    name,
    message.text!,
    now,
    message.message_id,
    replied?.message_id,
  );
  if (!(await db.is_feature_enabled(chat, "roast"))) return;
  const me = ctx.me;
  const mentioned = (message.entities ?? []).some((entity) =>
    entity.type === "text_mention"
      ? entity.user?.id === me.id
      : entity.type === "mention" &&
        message
          .text!.slice(entity.offset, entity.offset + entity.length)
          .toLowerCase() === `@${me.username.toLowerCase()}`,
  );
  const forced =
    mentioned ||
    (replied?.from?.id === me.id &&
      roast.isRoastMessage(chat, replied.message_id));
  const probability = await db.get_feature_value(chat, "roast");
  if (
    !forced &&
    !(await valueCheckpoint("roast-roll", () =>
      roast.shouldRoast(chat, now, probability),
    ))
  )
    return;
  await ctx.api.sendChatAction(chat, "typing");
  const result = await externalCheckpoint("roast", () =>
    roast.generateRoast(
      chat,
      name,
      message.text!,
      now,
      message.message_id,
      replied?.message_id,
      ctx.from!.id,
    ),
  );
  if (!result) return;
  const sentAt = await valueCheckpoint("roast-time", nowSeconds);
  getRoastState(chat).last_roast = sentAt;
  let text = result;
  while (escapeHtml(text).length > roast.TELEGRAM_MAX_MESSAGE_LEN)
    text = text.slice(0, -2) + "…";
  const sent = await ctx.reply(escapeHtml(text), {
    reply_parameters: { message_id: message.message_id },
  });
  roast.rememberRoastMessage(chat, sent.message_id);
  roast.rememberBotMessage(chat, result, sentAt, sent.message_id);
  // Append after existing checkpoints so incomplete older work keeps its order.
  await externalCheckpoint("roast-memory-add", () =>
    storeMemoryTurn(
      chat,
      ctx.from!.id,
      message.text!,
      text,
      message.message_id,
    ),
  );
}
