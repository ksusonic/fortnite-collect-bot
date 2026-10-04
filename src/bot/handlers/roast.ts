import { storeMemoryTurn } from "../memory";
import type { Context } from "grammy";
import * as roast from "../roast";
import { getRoastPolicy } from "../flags";
import { proactiveDue } from "../services/roast-policy";
import { loadRoastProfile, saveRoastProfile } from "../services/roast-profile";
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
  const me = ctx.me;
  const mentioned = (message.entities ?? []).some((entity) =>
    entity.type === "text_mention"
      ? entity.user?.id === me.id
      : entity.type === "mention" &&
        message
          .text!.slice(entity.offset, entity.offset + entity.length)
          .toLowerCase() === `@${me.username.toLowerCase()}`,
  );
  const addressed = mentioned || replied?.from?.id === me.id;
  const profile = await loadRoastProfile(chat);
  // Explicitly muted chats need no Flags request for unrelated conversation.
  if (!addressed && profile.preferences.proactive === false) return;
  const policy = await getRoastPolicy();
  const preferences = { ...policy.defaults, ...profile.preferences };
  if (
    !addressed &&
    !proactiveDue(policy, preferences, profile.last_evaluated_at, now)
  )
    return;
  // Persist the attempt even if the model skips or fails, bounding provider calls.
  profile.last_evaluated_at = now;
  await saveRoastProfile(chat, profile);
  if (addressed) await ctx.api.sendChatAction(chat, "typing");
  const decision = await externalCheckpoint("adaptive-roast-v1", () =>
    roast.generateRoastDecision(
      chat,
      name,
      message.text!,
      now,
      preferences,
      addressed,
      profile.pending_question,
      message.message_id,
      replied?.message_id,
      replied?.text,
      ctx.from!.id,
    ),
  );
  if (decision?.action === "skip") return;
  if (!decision && !addressed) return;
  if (decision?.action === "update" || decision?.action === "clarify") {
    if (decision.action === "update")
      Object.assign(profile.preferences, decision.patch);
    profile.pending_question =
      decision.action === "clarify" ? decision.text : null;
    await saveRoastProfile(chat, profile, {
      user: ctx.from.id,
      message: message.message_id,
      now,
    });
  }
  const result =
    decision?.text ??
    "Не удалось обработать обращение. Настройки не изменены; попробуй ещё раз.";
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
  if (decision?.action === "reply") {
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
}
