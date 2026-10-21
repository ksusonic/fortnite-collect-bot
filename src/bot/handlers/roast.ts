import { logEvent } from "../logging";
import {
  allowedReactions,
  reactToMessage,
} from "../services/conversation-reactions";
import type { Context } from "grammy";
import { GrammyError } from "grammy";
import { maybeRoast as legacyRoast } from "./roast-legacy";
import { getRoastPolicy } from "../flags";
import { confirmMemoryTurn, searchMemories, storeMemoryTurn } from "../memory";
import { getRoastState, query, timestamp } from "../storage";
import { externalCheckpoint, valueCheckpoint } from "../work";
import { loadRoastProfile, saveRoastProfile } from "../services/roast-profile";
import {
  decideConversation,
  interpretConversation,
} from "../services/conversation-model";
import {
  usesConversation,
  stateFor,
  recentSources,
  searchSources,
  sourceByRef,
  previousCitations,
  evaluateAt,
  saveDialogue,
  rememberSource,
  forgetSource,
  memoryEpoch,
  type Source,
} from "../services/conversation-store";
import { retryMemoryDeletions } from "../services/conversation-memory";
import { rememberBotMessage, rememberRoastMessage } from "../roast";
import { escapeHtml, isGroup, nowSeconds } from "./common";

export function messageLink(
  chat: number,
  type: string,
  username: string | undefined,
  id: number,
): string | null {
  if (type !== "supergroup" || !Number.isSafeInteger(id) || id <= 0)
    return null;
  if (username && /^[a-zA-Z0-9_]+$/.test(username))
    return `https://t.me/${username}/${id}`;
  const internal = String(chat).match(/^-100([1-9]\d*)$/)?.[1];
  return internal ? `https://t.me/c/${internal}/${id}` : null;
}
export function addressedByName(
  text: string,
  firstName: string,
  username: string,
): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [firstName, username, "грок", "grok"]
    .filter((n) => n.trim().length >= 3)
    .map(escape);
  return new RegExp(
    `^(?:эй[, ]+)?(?:${names.join("|")})(?=[\\s,:!?]|$)`,
    "iu",
  ).test(text.trim());
}
function sourceText(source: Source) {
  return `${source.name}, ${new Date(source.ts * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`;
}
export async function maybeRoast(ctx: Context): Promise<void> {
  if (!usesConversation()) return legacyRoast(ctx);
  const message = ctx.message
    ? { ...ctx.message, text: ctx.message.text ?? ctx.message.caption }
    : undefined;
  if (
    !message?.text ||
    !ctx.from ||
    ctx.from.is_bot ||
    message.sender_chat ||
    !ctx.chat ||
    !isGroup(ctx) ||
    message.text.startsWith("/")
  )
    return;
  const chat = ctx.chat.id,
    thread = message.message_thread_id ?? 0,
    user = ctx.from.id;
  const now = await valueCheckpoint("conversation-now-v2", nowSeconds);
  const state = await stateFor(chat, thread);
  const mentioned = (message.entities ?? []).some((e) =>
    e.type === "text_mention"
      ? e.user.id === ctx.me.id
      : e.type === "mention" &&
        message.text!.slice(e.offset, e.offset + e.length).toLowerCase() ===
          `@${ctx.me.username.toLowerCase()}`,
  );
  const continuation =
    state.dialogue_user_id === user && (state.dialogue_until ?? 0) >= now;
  const direct =
    /^(?:запомни|забудь|откуда (?:ты )?(?:знаешь|это знаешь|это взял))(?:\s|[,.!?]|$)/iu.test(
      message.text.trim(),
    ) ||
    mentioned ||
    message.reply_to_message?.from?.id === ctx.me.id ||
    addressedByName(message.text, ctx.me.first_name, ctx.me.username);
  const profile = await loadRoastProfile(chat);
  if (!direct && !continuation && profile.preferences.proactive === false)
    return;
  const policy = await getRoastPolicy();
  const preferences = { ...policy.defaults, ...profile.preferences };
  if (
    !direct &&
    !continuation &&
    (!policy.proactiveAllowed ||
      !preferences.proactive ||
      (state.evaluated_at != null && now - state.evaluated_at < 300))
  )
    return;
  await evaluateAt(chat, thread, now);
  const history = await recentSources(chat, thread, now);
  const pending =
    state.pending_user_id === user ? (state.pending_question ?? null) : null;
  const intent = await externalCheckpoint("conversation-intent-v2", () =>
    interpretConversation({
      text: message.text!,
      user,
      now,
      bot: ctx.me.first_name,
      direct,
      continuation,
      pending,
      history,
    }),
  );
  const addressed = direct || intent?.addressed === true;
  if (!addressed && (!policy.proactiveAllowed || !preferences.proactive))
    return;
  const allowReply =
    state.proactive_at == null ||
    now - state.proactive_at >= policy.intervals[preferences.frequency];
  const allowReaction =
    state.reacted_at == null || now - state.reacted_at >= 300;
  if (!addressed && (!intent || (!allowReply && !allowReaction))) return;
  if (addressed) await ctx.api.sendChatAction(chat, "typing");
  const candidates = intent
    ? await searchSources(chat, thread, now, intent.search)
    : [];
  // The received reply is archived from Telegram itself, even if older than our
  // search window. Its original date and tombstone still apply.
  const replySource = message.reply_to_message
    ? await sourceByRef(
        chat,
        thread,
        `s:${message.reply_to_message.message_id}`,
        now,
        true,
      )
    : undefined;
  if (
    replySource &&
    !history.some((s) => s.ref === replySource.ref) &&
    !candidates.some((s) => s.ref === replySource.ref)
  )
    candidates.unshift(replySource);
  for (const source of await previousCitations(
    chat,
    thread,
    now,
    message.reply_to_message?.from?.id === ctx.me.id
      ? message.reply_to_message.message_id
      : undefined,
  )) {
    if (
      !history.some((s) => s.ref === source.ref) &&
      !candidates.some((s) => s.ref === source.ref)
    )
      candidates.unshift(source);
  }
  candidates.splice(20);
  const epoch = await memoryEpoch(chat, user);
  const memories = await externalCheckpoint("conversation-mem0-search-v2", () =>
    searchMemories(chat, user, message.text!, epoch),
  );
  const reactions =
    addressed || allowReaction ? await allowedReactions(ctx) : [];
  const decision = intent
    ? await externalCheckpoint("conversation-decision-v2", () =>
        decideConversation({
          text: message.text!,
          user,
          now,
          addressed,
          operation: intent.operation,
          preferences,
          pending,
          history,
          candidates,
          memories,
          allowed_reactions: reactions,
          allow_proactive_reply: addressed || allowReply,
        }),
      )
    : null;
  logEvent("info", "conversation.decided", {
    status: decision?.action ?? "unavailable",
  });
  if (decision?.action === "skip" || (!decision && !addressed)) return;
  const sources = [...history, ...candidates];
  if (decision?.action === "react") {
    const source = sources.find((s) => s.ref === decision.source_ref);
    if (
      source &&
      source.user_id !== ctx.me.id &&
      reactions.includes(decision.emoji)
    )
      await reactToMessage(ctx, source.message_id, decision.emoji, thread, now);
    return;
  }
  if (!addressed && !allowReply) return;
  let text = decision
    ? decision.text
    : "Не удалось обработать обращение. Ничего не изменено; попробуй ещё раз.";
  let forgetting = false;
  if (decision?.action === "remember") {
    const source = sources.find((s) => s.ref === decision.source_ref)!;
    // Explicit saving cannot convert another participant's words into the caller's facts.
    if (source.user_id !== user)
      text = "Попроси автора сохранить это от своего имени.";
    else {
      await rememberSource(
        chat,
        source,
        decision.content,
        decision.expires_at,
        true,
      );
      text = "Запомнил.";
    }
  } else if (decision?.action === "forget") {
    const source = sources.find((s) => s.ref === decision.source_ref)!;
    forgetting = await forgetSource(chat, source, user, message.message_id);
    if (!forgetting)
      text = "Удалить это воспоминание может его автор или владелец бота.";
    else {
      getRoastState(chat).history = [];
      const deleted = await retryMemoryDeletions(chat, now);
      text = deleted
        ? "Забыл."
        : "Убрал из памяти бота. Удаление из внешней памяти ещё не завершено.";
    }
  } else if (decision?.action === "update") {
    Object.assign(profile.preferences, decision.patch);
    profile.pending_question = null;
    await saveRoastProfile(chat, profile, {
      user,
      message: message.message_id,
      now,
    });
  }
  const citations =
    decision && decision.action !== "forget" ? decision.sources : [];
  let html = escapeHtml(text);
  for (const ref of [...new Set(citations)].slice(0, 5)) {
    const source = sources.find((s) => s.ref === ref)!;
    const url = messageLink(
      chat,
      ctx.chat.type,
      "username" in ctx.chat ? ctx.chat.username : undefined,
      source.message_id,
    );
    html += url
      ? `\n<a href="${url}">${escapeHtml(sourceText(source))}</a>`
      : `\n${escapeHtml(sourceText(source))}: «${escapeHtml((source.quote ?? source.text).slice(0, 120))}»`;
  }
  // Input text is bounded at 2500 characters; escape expansion can still exceed Telegram's limit.
  if (html.length > 4096) html = escapeHtml(text.slice(0, 600));
  const replyRef =
    decision?.action === "reply" ? decision.reply_ref : undefined;
  const target = replyRef
    ? sources.find((s) => s.ref === replyRef)?.message_id
    : message.message_id;
  let sent;
  try {
    sent = await ctx.reply(html, {
      reply_parameters: { message_id: target ?? message.message_id },
      ...(thread ? { message_thread_id: thread } : {}),
    });
  } catch (error) {
    if (
      !(error instanceof GrammyError) ||
      error.error_code !== 400 ||
      !/message to be replied not found|reply message not found/i.test(
        error.description,
      ) ||
      target === message.message_id
    )
      throw error;
    // A confirmed rejection is safe to retry; transport uncertainty must stay ambiguous.
    sent = await ctx.reply(html, {
      reply_parameters: { message_id: message.message_id },
      ...(thread ? { message_thread_id: thread } : {}),
    });
  }
  const sentAt = await valueCheckpoint("conversation-sent-at-v2", nowSeconds);
  getRoastState(chat).last_roast = sentAt;
  rememberRoastMessage(chat, sent.message_id);
  // Do not retain deleted facts or their request in the short-lived model history.
  rememberBotMessage(chat, forgetting ? text : html, sentAt, sent.message_id);
  await query(
    `INSERT INTO conversation_messages(chat_id,message_id,user_id,name,text,sent_at,thread_id,reply_to_id,is_bot,processed,citation_refs)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,true,$9) ON CONFLICT DO NOTHING`,
    [
      chat,
      sent.message_id,
      ctx.me.id,
      ctx.me.first_name,
      forgetting ? text : html,
      timestamp(sentAt),
      thread,
      target ?? message.message_id,
      forgetting ? [] : citations,
    ],
  );
  await saveDialogue(
    chat,
    thread,
    user,
    sentAt,
    !addressed,
    decision?.action === "clarify" ? text : null,
  );
  if (decision?.action === "reply" && intent?.operation === "reply") {
    const submission = await externalCheckpoint(
      "conversation-mem0-add-v2",
      () =>
        storeMemoryTurn(
          chat,
          user,
          message.text!,
          text,
          message.message_id,
          epoch,
        ),
    );
    if (submission)
      await externalCheckpoint("conversation-mem0-confirm-v2", () =>
        confirmMemoryTurn(submission.eventId),
      );
  }
}
