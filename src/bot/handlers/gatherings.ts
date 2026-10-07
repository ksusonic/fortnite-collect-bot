import type { Bot, Context } from "grammy";
import * as db from "../db";
import * as messages from "../messages";
import * as roast from "../roast";
import { externalCheckpoint, valueCheckpoint } from "../work";
import {
  type ApiBot,
  answerCallback,
  displayName,
  ignoreTelegram,
  key,
  mskDate,
  nowSeconds,
  reply,
} from "./common";

export function parseTargetHour(raw: string): number | null {
  const token = raw.trim().split(/\s+/)[0] ?? "";
  const digits = token.split(":")[0]!.replace(/\D/g, "");
  if (!digits) return null;
  const hour = Number(digits);
  return hour <= messages.PLAY_DEADLINE_HOUR ? hour : null;
}
export async function closeSession(
  bot: ApiBot,
  session: db.Session,
  remove = false,
): Promise<void> {
  const now = await valueCheckpoint("close-session-time", nowSeconds);
  session.is_closed = true;
  if (session.is_complete)
    await db.mark_closed(session.message_id, session.chat_id);
  else {
    session.is_expired = true;
    await db.mark_expired(session.message_id, session.chat_id);
  }
  await ignoreTelegram(() =>
    remove
      ? bot.api.deleteMessage(session.chat_id, session.message_id)
      : bot.api.editMessageText(
          session.chat_id,
          session.message_id,
          messages.buildCancelledText(session, now),
        ),
  );
  db.getSessions().delete(key(session.chat_id, session.message_id));
}
export async function cmdFort(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat || !ctx.message) return;
  const now = await valueCheckpoint("fort-time", nowSeconds);
  const args = String(ctx.match ?? "").trim();
  const hour = args ? parseTargetHour(args) : null;
  if (args && hour === null) {
    await reply(
      ctx,
      `Не понял время. Укажи час сбора числом: <code>/fort 18</code> (допустимо до ${messages.PLAY_DEADLINE_HOUR}:00 МСК).`,
    );
    return;
  }
  if (hour !== null && hour <= mskDate(now).getUTCHours()) {
    await reply(
      ctx,
      "Это время уже прошло. Для сбора прямо сейчас напиши <code>/fort</code> без числа.",
    );
    return;
  }
  const last = await db.get_fort_cooldown(ctx.chat.id, ctx.from.id);
  if (last !== null && now - last < 30) {
    await ignoreTelegram(() => ctx.react("👎"));
    await ignoreTelegram(() => ctx.deleteMessage());
    return;
  }
  await db.set_fort_cooldown(ctx.chat.id, ctx.from.id, now);
  const active = [...db.getSessions().values()].find(
    (session) => session.chat_id === ctx.chat!.id && !session.is_closed,
  );
  if (active) await closeSession({ api: ctx.api }, active);
  const slots = await valueCheckpoint("fort-slots", () =>
    messages.generateTimeSlots(hour ?? undefined, now),
  );
  const participants = await db.get_chat_participants(ctx.chat.id);
  const session = db.newSession({
    chat_id: ctx.chat.id,
    message_id: 0,
    initiator_id: ctx.from.id,
    initiator_name: displayName(ctx.from),
    style: await valueCheckpoint("fort-style", messages.randomStyle),
    created_at: now,
    time_slots: slots,
    tagged_users: new Map(participants.filter(([id]) => id !== ctx.from!.id)),
    fort_title: await db.get_fort_title(ctx.chat.id),
  });
  const sent = await ctx.reply(messages.buildGatherText(session, now), {
    reply_markup: messages.buildKeyboard(0, slots),
  });
  session.message_id = sent.message_id;
  db.getSessions().set(key(session.chat_id, sent.message_id), session);
  await db.save_session(session);
  await ignoreTelegram(() => ctx.deleteMessage());
  const header = await externalCheckpoint("fort-header", () =>
    roast.generateFortHeader(session.chat_id, now),
  );
  if (header && !session.is_closed) {
    session.llm_header = header;
    await db.save_session(session);
    await ignoreTelegram(() =>
      ctx.api.editMessageText(
        session.chat_id,
        session.message_id,
        messages.buildGatherText(session, now),
        {
          reply_markup: messages.buildKeyboard(
            Math.min(session.go_players.size, messages.SQUAD_SIZE),
            slots,
          ),
        },
      ),
    );
  }
}
export async function onCallback(ctx: Context): Promise<void> {
  const callback = ctx.callbackQuery;
  if (!callback?.message || !ctx.from) {
    await answerCallback(ctx);
    return;
  }
  const chat = callback.message.chat.id,
    message = callback.message.message_id;
  const sessionKey = key(chat, message);
  let session = db.getSessions().get(sessionKey);
  if (!session) {
    session = (await db.load_session(message, chat)) ?? undefined;
    if (session) db.getSessions().set(sessionKey, session);
  }
  if (!session) {
    await answerCallback(ctx, "Сбор устарел");
    return;
  }
  if (session.is_closed) {
    await answerCallback(ctx, "Сбор завершён.");
    return;
  }
  const now = await valueCheckpoint("callback-time", nowSeconds);
  const raw = callback.data ?? "",
    id = ctx.from.id,
    name = displayName(ctx.from);
  let action: "go" | "pass" = raw === "pass" ? "pass" : "go",
    slot: string | null = null;
  if (raw.startsWith("slot:")) {
    action = "go";
    const offer = raw.slice(5);
    if (!session.time_slots.includes(offer)) {
      await answerCallback(ctx, "Слот недоступен.");
      return;
    }
    slot =
      offer === messages.NOW_SLOT || !/^\d+$/.test(offer)
        ? offer
        : await valueCheckpoint("callback-slot", () =>
            mskDate(now + Number(offer) * 60)
              .toISOString()
              .slice(11, 16),
          );
  }
  const alreadyGo = session.go_players.has(id);
  if (action === "go" && !slot && alreadyGo) {
    await answerCallback(ctx, "Ты уже в деле!");
    return;
  }
  if (action === "pass" && session.pass_players.has(id)) {
    await answerCallback(ctx, "Ты уже в списке пасующих.");
    return;
  }
  if (
    action === "go" &&
    !alreadyGo &&
    session.go_players.size >= messages.SQUAD_SIZE + messages.RESERVE_SIZE
  ) {
    await answerCallback(ctx, "Резерв заполнен.");
    return;
  }
  const oldGo = new Map(session.go_players),
    oldPass = new Map(session.pass_players),
    oldSlots = new Map(session.player_slots);
  if (action === "go") {
    session.pass_players.delete(id);
    session.go_players.set(id, name);
    if (slot) session.player_slots.set(id, slot);
  } else {
    session.go_players.delete(id);
    session.player_slots.delete(id);
    session.pass_players.set(id, name);
  }
  const complete =
    !session.is_complete && session.go_players.size >= messages.SQUAD_SIZE;
  try {
    await db.save_response(message, id, name, action, {
      time_slot: slot,
      is_bot: ctx.from.is_bot,
      became_complete: complete,
      chat_id: chat,
    });
  } catch (error) {
    session.go_players = oldGo;
    session.pass_players = oldPass;
    session.player_slots = oldSlots;
    throw error;
  }
  if (complete) {
    session.is_complete = true;
    session.completed_at = now;
  }
  const [squad, reserve] = messages.splitRoster(session);
  await ignoreTelegram(() =>
    ctx.api.editMessageText(
      chat,
      message,
      messages.buildGatherText(session!, now),
      { reply_markup: messages.buildKeyboard(squad.size, session!.time_slots) },
    ),
  );
  if (action === "go" && reserve.has(id))
    await answerCallback(
      ctx,
      `Сквад полон — ты в резерве №${[...reserve.keys()].indexOf(id) + 1}.`,
    );
  else await answerCallback(ctx);
}
export async function sweep_expired_sessions(
  bot: Bot,
  now?: number,
  past_deadline?: boolean,
): Promise<number[]> {
  now ??= await valueCheckpoint("sweep-time", nowSeconds);
  past_deadline ??= mskDate(now).getUTCHours() >= messages.PLAY_DEADLINE_HOUR;
  const expired = [];
  for (const session of [...db.getSessions().values()]) {
    const [squad] = messages.splitRoster(session);
    const timeout =
      squad.size >= 2
        ? messages.SESSION_TIMEOUT_TRACTION
        : messages.SESSION_TIMEOUT;
    if (
      session.is_closed ||
      (!past_deadline && now - session.created_at <= timeout)
    )
      continue;
    session.is_closed = true;
    if (session.is_complete)
      await db.mark_closed(session.message_id, session.chat_id);
    else {
      session.is_expired = true;
      await db.mark_expired(session.message_id, session.chat_id);
    }
    await ignoreTelegram(() =>
      bot.api.editMessageText(
        session.chat_id,
        session.message_id,
        messages.buildExpiredText(session, now),
      ),
    );
    db.getSessions().delete(key(session.chat_id, session.message_id));
    expired.push(session.message_id);
  }
  return expired;
}
