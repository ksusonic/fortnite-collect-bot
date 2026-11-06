import { GrammyError, type Bot, type Context } from "grammy";
import * as db from "../db";
import * as messages from "../messages";
import * as roast from "../roast";
import { interpretGatheringMessage } from "../gathering-intent";
import {
  changePlayer,
  clock,
  eveningEnd,
  gatheringState,
  gatheringGame,
  gatheringCommand,
  type GatheringGame,
  mentionsOtherDay,
  parseGatheringTime,
  rosterTimes,
  validTime,
  type GatheringDecision,
  type GatheringPrompt,
} from "../services/gathering";
import { externalCheckpoint, valueCheckpoint } from "../work";
import {
  type ApiBot,
  answerCallback,
  displayName,
  ignoreTelegram,
  key,
  nowSeconds,
  reply,
} from "./common";

// Kept for callers of the former public parser; command parsing now preserves minutes.
export function parseTargetHour(raw: string): number | null {
  const match = /^(?:в\s+)?(\d{1,2})(?::[0-5]\d)?$/.exec(raw.trim());
  return match && Number(match[1]) < 24 ? Number(match[1]) : null;
}
async function telegramResult(
  action: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    return false;
  }
}
export async function renderGathering(
  bot: ApiBot,
  session: db.Session,
  now: number,
) {
  await ignoreTelegram(() =>
    bot.api.editMessageText(
      session.chat_id,
      session.message_id,
      messages.buildGatherText(session, now),
      { reply_markup: messages.buildGatheringKeyboard(session, now) },
    ),
  );
}
export async function closeSession(
  bot: ApiBot,
  session: db.Session,
  remove = false,
): Promise<void> {
  const now = await valueCheckpoint("close-session-time-v2", nowSeconds);
  const state = await valueCheckpoint("close-session-state-v2", () => ({
    ...gatheringState(session),
    prompts: {},
    close_reason: remove ? ("cancelled" as const) : ("evening_end" as const),
  }));
  session.is_closed = true;
  session.gathering = state;
  await db.save_session(session);
  // Always specify the message: never remove somebody else's pinned messages.
  await ignoreTelegram(() =>
    bot.api.unpinChatMessage(session.chat_id, session.message_id),
  );
  const deleted =
    remove &&
    (await telegramResult(() =>
      bot.api.deleteMessage(session.chat_id, session.message_id),
    ));
  if (!deleted) {
    await ignoreTelegram(() =>
      bot.api.editMessageText(
        session.chat_id,
        session.message_id,
        remove
          ? messages.buildCancelledText(session, now)
          : messages.buildExpiredText(session, now),
        { reply_markup: { inline_keyboard: [] } },
      ),
    );
    if (remove)
      await bot.api.sendMessage(
        session.chat_id,
        "Сбор закрыт, но Telegram не разрешил удалить карточку. Проверь право бота на удаление сообщений.",
      );
  }
  db.getSessions().delete(key(session.chat_id, session.message_id));
}
async function activeSession(
  ctx: Context,
  now: number,
  game: GatheringGame = "fortnite",
): Promise<db.Session | undefined> {
  const id = await valueCheckpoint(
    "active-gathering-v2",
    () =>
      [...db.getSessions().values()].find(
        (s) =>
          s.chat_id === ctx.chat?.id &&
          !s.is_closed &&
          gatheringGame(s) === game,
      )?.message_id ?? null,
  );
  if (id === null || !ctx.chat) return;
  const session =
    db.getSessions().get(key(ctx.chat.id, id)) ??
    (await db.load_session(id, ctx.chat.id));
  if (!session) return;
  if (now >= eveningEnd(session.created_at)) {
    await closeSession({ api: ctx.api }, session);
    return;
  }
  return session;
}
async function timeDecision(
  text: string,
  now: number,
): Promise<GatheringDecision | null> {
  if (mentionsOtherDay(text)) return { action: "clarify" };
  const parsed = parseGatheringTime(text, now);
  if (parsed !== null)
    return { action: "set_time", at: Number.isFinite(parsed) ? parsed : -1 };
  return externalCheckpoint("gathering-intent-v2", () =>
    interpretGatheringMessage({
      text,
      now,
      participating: false,
      passed: false,
    }),
  );
}
const TIME_HELP =
  "Укажи время сегодня до полуночи МСК: например, 19:30 или через час.";
export async function cmdFort(ctx: Context): Promise<void> {
  return cmdGathering(ctx, "fortnite");
}
export async function cmdWarcraft(ctx: Context): Promise<void> {
  return cmdGathering(ctx, "warcraft");
}
const WARCRAFT_INVITES = ["@dim_led", "@ksusonic", "@Sirius_Auror"];
async function cmdGathering(ctx: Context, game: GatheringGame): Promise<void> {
  if (
    !ctx.from ||
    !ctx.chat ||
    !ctx.message ||
    ctx.from.is_bot ||
    ctx.message.sender_chat
  )
    return;
  const now = await valueCheckpoint("fort-time-v2", nowSeconds);
  const args = String(ctx.match ?? "").trim();
  const decision = args ? await timeDecision(args, now) : null;
  if (
    args &&
    (!decision ||
      decision.action !== "set_time" ||
      decision.confirm ||
      decision.at === undefined ||
      !validTime(decision.at, now))
  ) {
    await reply(ctx, TIME_HELP);
    return;
  }
  const active = await activeSession(ctx, now, game);
  if (active) {
    if (decision) {
      const error = await changePlayer(
        active,
        ctx.from.id,
        displayName(ctx.from),
        decision,
        now,
      );
      if (error) {
        await reply(ctx, error);
        return;
      }
      await renderGathering({ api: ctx.api }, active, now);
    }
    await telegramResult(() => ctx.react("👍"));
    return;
  }
  const last = await db.get_fort_cooldown(ctx.chat.id, ctx.from.id, game);
  if (last !== null && now - last < 30) {
    await reply(ctx, "Новый сбор можно создать через несколько секунд.");
    return;
  }
  await db.set_fort_cooldown(ctx.chat.id, ctx.from.id, now, game);
  const participants =
    game === "fortnite" ? await db.get_chat_participants(ctx.chat.id) : [];
  const invites: string[] = [];
  if (game === "warcraft") {
    for (const username of WARCRAFT_INVITES) {
      if (username.toLowerCase() === displayName(ctx.from).toLowerCase())
        continue;
      const user = await db.resolve_user_by_username(ctx.chat.id, username);
      if (user) {
        const until = await db.get_afk_until(ctx.chat.id, user[0]);
        if (until !== null && until > now) continue;
        participants.push(user);
      } else invites.push(username);
    }
  }
  const emojiId =
    game === "warcraft"
      ? await externalCheckpoint("warcraft-emoji-pack-v1", async () => {
          try {
            const pack = await ctx.api.getStickerSet("rumble_es");
            return (
              pack.stickers.find((s) => s.custom_emoji_id)?.custom_emoji_id ??
              null
            );
          } catch (error) {
            if (!(error instanceof GrammyError)) throw error;
            return null;
          }
        })
      : null;
  const at = decision?.at ?? now;
  const session = db.newSession({
    chat_id: ctx.chat.id,
    message_id: 0,
    initiator_id: ctx.from.id,
    initiator_name: displayName(ctx.from),
    style: await valueCheckpoint("fort-style-v2", messages.randomStyle),
    created_at: now,
    time_slots: messages.generateTimeSlots(null, now),
    go_players: new Map([[ctx.from.id, displayName(ctx.from)]]),
    availability: new Map([[ctx.from.id, at]]),
    ready_players: new Set(),
    player_slots: new Map([[ctx.from.id, clock(at)]]),
    tagged_users: new Map(participants.filter(([id]) => id !== ctx.from!.id)),
    fort_title:
      game === "fortnite" ? await db.get_fort_title(ctx.chat.id) : null,
    ...(game === "warcraft"
      ? {
          gathering: {
            game,
            invite_usernames: invites,
            ...(emojiId ? { emoji_id: emojiId } : {}),
            prompts: {},
            revisions: {},
          },
        }
      : {}),
  });
  const sent = await ctx.reply(messages.buildGatherText(session, now), {
    reply_markup: messages.buildGatheringKeyboard(session, now),
  });
  session.message_id = sent.message_id;
  db.getSessions().set(key(session.chat_id, session.message_id), session);
  await db.save_session(session);
  await db.save_response(
    session.message_id,
    ctx.from.id,
    displayName(ctx.from),
    "go",
    {
      chat_id: session.chat_id,
      time_slot: clock(at),
      available_at: at,
    },
  );
  await ignoreTelegram(() => ctx.deleteMessage());
  const pinned = await telegramResult(() =>
    ctx.api.pinChatMessage(session.chat_id, session.message_id, {
      disable_notification: true,
    }),
  );
  if (!pinned)
    await reply(
      ctx,
      "Сбор создан, но закрепить карточку не удалось. Проверь право бота на закрепление сообщений.",
    );
  if (game === "warcraft") return;
  const header = await externalCheckpoint("fort-header-v2", () =>
    roast.generateFortHeader(session.chat_id, now),
  );
  if (header) {
    session.llm_header = header;
    await db.save_session(session);
    await renderGathering({ api: ctx.api }, session, now);
  }
}
async function prompt(
  ctx: Context,
  session: db.Session,
  now: number,
  decision?: GatheringDecision,
) {
  const description =
    decision?.action === "set_time"
      ? `сможешь с ${clock(decision.at!)}`
      : decision?.action === "ready"
        ? "готов играть сейчас"
        : decision?.action === "pass"
          ? "сегодня пас"
          : decision?.action === "join"
            ? "в деле, время пока не указано"
            : decision?.at !== undefined
              ? `отошёл, вернёшься к ${clock(decision.at)}`
              : "отошёл, время возвращения неизвестно";
  const text = decision ? `Правильно понял: ${description}?` : TIME_HELP;
  const sent = await ctx.reply(
    `<a href="tg://user?id=${ctx.from!.id}">${messages.escapeHtml(displayName(ctx.from!))}</a>, ${text}`,
    {
      reply_parameters: ctx.message
        ? { message_id: ctx.message.message_id }
        : undefined,
      reply_markup: decision
        ? {
            inline_keyboard: [
              [
                {
                  text: "✅ Да",
                  callback_data: `gconfirm:${session.message_id}`,
                },
                {
                  text: "Отмена",
                  callback_data: `gdismiss:${session.message_id}`,
                },
              ],
            ],
          }
        : {
            force_reply: true,
            selective: true,
            input_field_placeholder: "19:30 или через 20 минут",
          },
    },
  );
  const next = await valueCheckpoint("gathering-prompt-v2", () => {
    const state = structuredClone(gatheringState(session));
    for (const [id, old] of Object.entries(state.prompts))
      if (old.user === ctx.from!.id || old.expires <= now)
        state.prompts[id] = { ...old, invalidated: true };
    // Keep bounded tombstones so delayed replies cannot revive old requests.
    for (const id of Object.keys(state.prompts).slice(0, -127))
      delete state.prompts[id];
    state.prompts[sent.message_id] = {
      user: ctx.from!.id,
      expires: now + 600,
      revision: state.revisions[ctx.from!.id] ?? 0,
      ...(decision ? { decision } : {}),
    };
    return state;
  });
  session.gathering = next;
  await db.save_session(session);
}
async function feedback(ctx: Context, error: string | null) {
  if (error) {
    await reply(ctx, error);
    return;
  }
  await telegramResult(() => ctx.react("👍"));
}
export async function onCallback(ctx: Context): Promise<void> {
  const callback = ctx.callbackQuery;
  if (!callback?.message || !ctx.from || ctx.from.is_bot) {
    await answerCallback(ctx);
    return;
  }
  const raw = callback.data ?? "",
    chat = callback.message.chat.id;
  const confirmation = /^(gconfirm|gdismiss):(-?\d+)$/.exec(raw);
  const readyNotice = /^gready:(\d+)$/.exec(raw);
  const mid = confirmation
    ? Number(confirmation[2])
    : readyNotice
      ? Number(readyNotice[1])
      : callback.message.message_id;
  const session =
    db.getSessions().get(key(chat, mid)) ?? (await db.load_session(mid, chat));
  const now = await valueCheckpoint("callback-time-v2", nowSeconds);
  if (!session || session.is_closed || now >= eveningEnd(session.created_at)) {
    await answerCallback(
      ctx,
      `Сбор завершён. Создай новый: ${session ? gatheringCommand(session) : "/fort или /warcraft"}.`,
    );
    return;
  }
  if (confirmation) {
    const pending = await valueCheckpoint(
      "gathering-confirmation-v2",
      () =>
        gatheringState(session).prompts[callback.message!.message_id] ?? null,
    );
    if (
      !pending ||
      pending.invalidated ||
      pending.user !== ctx.from.id ||
      pending.expires <= now ||
      pending.revision !== (gatheringState(session).revisions[ctx.from.id] ?? 0)
    ) {
      await answerCallback(ctx, "Подтверждение недоступно или устарело.");
      return;
    }
    if (confirmation[1] === "gconfirm" && pending.decision) {
      const error = await changePlayer(
        session,
        ctx.from.id,
        displayName(ctx.from),
        pending.decision,
        now,
      );
      if (error) {
        await answerCallback(ctx, error);
        return;
      }
      await renderGathering({ api: ctx.api }, session, now);
    } else {
      delete gatheringState(session).prompts[callback.message.message_id];
      await db.save_session(session);
    }
    await ignoreTelegram(() =>
      ctx.api.editMessageReplyMarkup(chat, callback.message!.message_id, {
        reply_markup: { inline_keyboard: [] },
      }),
    );
    await answerCallback(ctx, "Готово");
    return;
  }
  if (raw === "gtime") {
    await answerCallback(ctx);
    await prompt(ctx, session, now);
    return;
  }
  let decision: GatheringDecision;
  if (raw === "pass") decision = { action: "pass" };
  else if (
    readyNotice ||
    raw === "gready" ||
    raw === "slot:now" ||
    raw === "go"
  )
    decision = { action: "ready" };
  else if (/^gat:\d+(?:\.\d+)?$/.test(raw))
    decision = { action: "set_time", at: Number(raw.slice(4)) };
  else {
    const match = /^(?:gslot|slot):(.+)$/.exec(raw);
    if (
      !match ||
      !(
        messages.SLOT_OFFERS_MIN.map(String).includes(match[1]!) ||
        session.time_slots.includes(match[1]!)
      )
    ) {
      await answerCallback(ctx, "Слот недоступен.");
      return;
    }
    const offer = match[1]!;
    decision = {
      action: "set_time",
      at: /^\d+$/.test(offer)
        ? now + Number(offer) * 60
        : (parseGatheringTime(offer, now) ?? -1),
    };
  }
  const error = await changePlayer(
    session,
    ctx.from.id,
    displayName(ctx.from),
    decision,
    now,
  );
  if (!error) await renderGathering({ api: ctx.api }, session, now);
  const [, reserve] = messages.splitRoster(session);
  await answerCallback(
    ctx,
    error ??
      (reserve.has(ctx.from.id)
        ? `Ты в резерве №${[...reserve.keys()].indexOf(ctx.from.id) + 1}.`
        : undefined),
  );
}
export async function maybeGatheringMessage(ctx: Context): Promise<boolean> {
  const message = ctx.message;
  if (
    !message?.text ||
    !ctx.from ||
    ctx.from.is_bot ||
    message.sender_chat ||
    message.forward_origin ||
    message.text.startsWith("/")
  )
    return false;
  const now = await valueCheckpoint("gathering-message-time-v2", nowSeconds);
  const target = await valueCheckpoint("gathering-message-target-v3", () => {
    const sessions = [...db.getSessions().values()].filter(
      (s) =>
        s.chat_id === ctx.chat?.id &&
        !s.is_closed &&
        now < eveningEnd(s.created_at),
    );
    const replyId = message.reply_to_message?.message_id;
    if (replyId !== undefined) {
      const linked = sessions.find(
        (s) => s.message_id === replyId || !!s.gathering?.prompts[replyId],
      );
      // A reply to another message must not change an unrelated gathering.
      return linked?.message_id ?? null;
    }
    const warcraft = /(?:warcraft|варкрафт)/iu.test(message.text!);
    const fortnite = /(?:fortnite|фортнайт)/iu.test(message.text!);
    if (warcraft !== fortnite)
      return (
        sessions.find(
          (s) => gatheringGame(s) === (warcraft ? "warcraft" : "fortnite"),
        )?.message_id ?? null
      );
    if (sessions.length === 1) return sessions[0]!.message_id;
    const joined = sessions.filter(
      (s) => s.go_players.has(ctx.from!.id) || s.pass_players.has(ctx.from!.id),
    );
    return joined.length === 1 ? joined[0]!.message_id : null;
  });
  const session =
    target === null
      ? undefined
      : db.getSessions().get(key(ctx.chat!.id, target));
  if (!session) {
    const joined = [...db.getSessions().values()].filter(
      (s) =>
        !s.is_closed &&
        now < eveningEnd(s.created_at) &&
        s.go_players.has(ctx.from!.id),
    );
    if (!message.reply_to_message && joined.length > 1) {
      const decision = await externalCheckpoint(
        "gathering-ambiguous-intent-v1",
        () =>
          interpretGatheringMessage({
            text: message.text!,
            now,
            participating: true,
            passed: false,
          }),
      );
      if (decision && decision.action !== "ignore") {
        await reply(
          ctx,
          "В каком сборе меняем статус — Fortnite или Warcraft? Ответь на нужную карточку или нажми её кнопку.",
        );
        return true;
      }
    }
    return false;
  }
  const state = gatheringState(session);
  const pending: GatheringPrompt | undefined = message.reply_to_message
    ? state.prompts[message.reply_to_message.message_id]
    : undefined;
  const mention = (message.entities ?? []).some((entity) =>
    entity.type === "text_mention"
      ? entity.user.id === ctx.me.id
      : entity.type === "mention" &&
        message
          .text!.slice(entity.offset, entity.offset + entity.length)
          .toLowerCase() === `@${ctx.me.username.toLowerCase()}`,
  );
  const addressed =
    mention ||
    message.reply_to_message?.message_id === session.message_id ||
    !!pending;
  if (message.reply_to_message?.from?.id === ctx.me.id && !addressed)
    return false;
  const participating = session.go_players.has(ctx.from.id),
    passed = session.pass_players.has(ctx.from.id);
  if (!participating && !addressed && !passed) return false;
  if (
    pending &&
    (pending.invalidated ||
      pending.user !== ctx.from.id ||
      pending.expires <= now ||
      pending.revision !== (state.revisions[ctx.from.id] ?? 0))
  ) {
    await reply(
      ctx,
      "Этот запрос времени устарел. Нажми «Своё время» в текущем сборе.",
    );
    return true;
  }
  const decision = await externalCheckpoint(
    "gathering-message-intent-v2",
    async () => {
      const parsed = parseGatheringTime(message.text!, now);
      if (
        parsed !== null &&
        (addressed ||
          (participating && !/^\d{1,2}$/.test(message.text!.trim())))
      )
        return {
          action: "set_time" as const,
          at: Number.isFinite(parsed) ? parsed : -1,
        };
      return interpretGatheringMessage({
        text: message.text!,
        reply: message.reply_to_message?.text,
        now,
        participating,
        passed,
      });
    },
  );
  if (!decision) {
    if (addressed) {
      await reply(ctx, `Не удалось разобрать сообщение. ${TIME_HELP}`);
      return true;
    }
    return false;
  }
  if (decision.action === "ignore") return false;
  if (mentionsOtherDay(message.text)) {
    await reply(ctx, TIME_HELP);
    return true;
  }
  if (passed && !addressed && !decision.rejoin) return false;
  if (decision.action === "clarify") {
    await prompt(ctx, session, now);
    return true;
  }
  if (
    decision.at !== undefined &&
    !validTime(decision.at, now, session.created_at)
  ) {
    await reply(ctx, TIME_HELP);
    return true;
  }
  if (decision.confirm) {
    await prompt(ctx, session, now, decision);
    return true;
  }
  const error = await changePlayer(
    session,
    ctx.from.id,
    displayName(ctx.from),
    decision,
    now,
  );
  if (!error) await renderGathering({ api: ctx.api }, session, now);
  await feedback(ctx, error);
  return true;
}
export async function sweep_expired_sessions(
  bot: Bot,
  now?: number,
  past_deadline?: boolean,
): Promise<number[]> {
  void past_deadline; // Legacy job payload: only the calendar boundary closes a gathering now.
  now ??= await valueCheckpoint("sweep-time-v2", nowSeconds);
  const expired: number[] = [];
  for (const session of [...db.getSessions().values()]) {
    if (session.is_closed || now < eveningEnd(session.created_at)) continue;
    await closeSession(bot, session);
    expired.push(session.message_id);
  }
  return expired;
}
export async function gatheringTick(bot: Bot, mid: number, now?: number) {
  now ??= await valueCheckpoint("gathering-tick-time-v2", nowSeconds);
  const session = [...db.getSessions().values()].find(
    (s) => s.message_id === mid && !s.is_closed,
  );
  if (!session) return;
  if (now >= eveningEnd(session.created_at)) {
    await closeSession(bot, session);
    return;
  }
  const due = await valueCheckpoint("gathering-reminder-v2", () => {
    const times = rosterTimes(session);
    return !gatheringState(session).notified_at && times.ready >= 2;
  });
  if (!due) return;
  const squad = [...session.go_players].slice(0, 4);
  const ready = squad.filter(([id]) => session.ready_players?.has(id));
  const roster = ready
    .map(
      ([id, name]) =>
        `<a href="tg://user?id=${id}">${messages.escapeHtml(name)}</a>`,
    )
    .join("\n");
  const waiting = ready.length < squad.length;
  const title = ready.length === 2 ? "Двое готовы" : `Готовы ${ready.length}`;
  await bot.api.sendMessage(
    session.chat_id,
    `🎮 ${gatheringGame(session) === "warcraft" ? "Warcraft · " : ""}${title} — можно залетать\n${roster}${waiting ? "\nОстальные — жмите «✅ Готов играть», когда подключитесь." : ""}`,
    {
      reply_parameters: { message_id: session.message_id },
      ...(waiting
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ Готов играть",
                    callback_data: `gready:${session.message_id}`,
                  },
                ],
              ],
            },
          }
        : {}),
    },
  );
  gatheringState(session).notified_at = now;
  await db.save_session(session);
}
