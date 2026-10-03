import { Bot, Context, GrammyError } from "grammy";
import type { User } from "grammy/types";
import * as db from "./db";
import { getRoastState } from "./storage";
import { externalCheckpoint, valueCheckpoint } from "./work";
import * as messages from "./messages";
import * as fortnite from "./fortnite";
import * as roast from "./roast";

const GROUP_ONLY = "Эта команда работает только в группах.";
type ApiBot = Pick<Bot, "api">;
const ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID ?? "0");
const nowSeconds = () => Date.now() / 1000;
const key = (chat: number, message: number) => `${chat}:${message}`;
export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
export const displayName = (user: User) =>
  user.username ? `@${user.username}` : user.first_name || String(user.id);
const mskDate = (seconds: number) => new Date((seconds + 10800) * 1000);
function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}
async function ignoreTelegram(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
  }
}
async function reply(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text);
}
export function parseTargetHour(raw: string): number | null {
  const token = raw.trim().split(/\s+/)[0] ?? "";
  const digits = token.split(":")[0]!.replace(/\D/g, "");
  if (!digits) return null;
  const hour = Number(digits);
  return hour <= messages.PLAY_DEADLINE_HOUR ? hour : null;
}
export function appendTeamAnalysis(html: string, text: string): string {
  const header = "\n────────────────────\n🤖 <b>Анализ Grok</b>\n";
  const budget =
    roast.TELEGRAM_MAX_MESSAGE_LEN - html.length - header.length - 7;
  if (budget <= 1) return html;
  let escaped = escapeHtml(text);
  if (escaped.length > budget) {
    const cut = Math.max(0, text.length - (escaped.length - budget + 1));
    escaped = escapeHtml(text.slice(0, cut).trimEnd() + "…");
    if (escaped.length > budget) return html;
  }
  return `${html}${header}<i>${escaped}</i>`;
}
function epicErrorText(error: fortnite.FortniteError): string {
  if (error instanceof fortnite.EpicNameNotFound)
    return "Не нашёл такой Epic-аккаунт. Проверь ник.";
  if (error instanceof fortnite.StatsPrivate)
    return "Статистика этого аккаунта закрыта. Включи Public Game Stats в настройках Fortnite.";
  if (error instanceof fortnite.StatsEmpty)
    return "У тебя 0 матчей. Сыграй пару каток и приходи.";
  if (error instanceof fortnite.FortniteUnavailable)
    return "Fortnite API сейчас недоступен. Попробуй позже.";
  return "Не получилось получить статистику Fortnite.";
}
async function setSessionPin(
  bot: ApiBot,
  session: db.Session,
  pinned: boolean,
): Promise<void> {
  await ignoreTelegram(() =>
    pinned
      ? bot.api.pinChatMessage(session.chat_id, session.message_id, {
          disable_notification: true,
        })
      : bot.api.unpinChatMessage(session.chat_id, session.message_id),
  );
}
async function closeSession(
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
  await setSessionPin(bot, session, false);
  db.getSessions().delete(key(session.chat_id, session.message_id));
}
async function cmdFort(ctx: Context): Promise<void> {
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
  const bot = { api: ctx.api };
  await setSessionPin(bot, session, true);
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
async function cmdFortemoji(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
  if (member.status !== "creator" && member.status !== "administrator") {
    await reply(
      ctx,
      "Настроить заголовок сбора может только администратор чата.",
    );
    return;
  }
  if (ctx.match === "off") {
    await db.set_fort_title(ctx.chat.id, null);
    await reply(ctx, "В новых сборах будет обычный заголовок 🎮 FORT.");
    return;
  }
  const source = ctx.message?.reply_to_message;
  const entities = (source?.entities ?? source?.caption_entities ?? [])
    .filter((entity) => entity.type === "custom_emoji")
    .sort((a, b) => a.offset - b.offset);
  if (entities.length !== 4) {
    await reply(
      ctx,
      "Напиши FORT четырьмя emoji из WideABC и ответь на это сообщение командой /fortemoji. Отключить: /fortemoji off.",
    );
    return;
  }
  let pack;
  try {
    pack = await ctx.api.getStickerSet("WideABC");
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    await reply(ctx, "Не удалось проверить WideABC. Попробуй ещё раз позже.");
    return;
  }
  const ids = new Set(pack.stickers.map((sticker) => sticker.custom_emoji_id));
  if (entities.some((entity) => !ids.has(entity.custom_emoji_id))) {
    await reply(
      ctx,
      "Все четыре буквы должны быть emoji из набора https://t.me/addemoji/WideABC.",
    );
    return;
  }
  const text = source?.text ?? source?.caption ?? "";
  const title = entities
    .map(
      (entity) =>
        `<tg-emoji emoji-id="${entity.custom_emoji_id}">${escapeHtml(text.slice(entity.offset, entity.offset + entity.length))}</tg-emoji>`,
    )
    .join("");
  try {
    await reply(ctx, `Заголовок новых сборов: ${title}`);
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    await reply(
      ctx,
      "Telegram не принял custom emoji. Проверь Premium у владельца бота.",
    );
    return;
  }
  await db.set_fort_title(ctx.chat.id, title);
}
async function cmdAfk(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const arg = String(ctx.match ?? "")
    .trim()
    .toLowerCase();
  if (arg === "off") {
    await db.clear_afk(ctx.chat.id, ctx.from.id);
    await reply(ctx, "Снова буду звать тебя в новых /fort сборах.");
    return;
  }
  const match = /^([1-9]\d{0,3})([dw])$/.exec(arg);
  if (!match) {
    await reply(ctx, "Использование: /afk 1d, /afk 2w или /afk off");
    return;
  }
  const until = await valueCheckpoint(
    "afk-until",
    () => nowSeconds() + Number(match[1]) * (match[2] === "w" ? 7 : 1) * 86400,
  );
  await db.set_afk(ctx.chat.id, ctx.from.id, until);
  const date = mskDate(until);
  const pad = (value: number) => String(value).padStart(2, "0");
  await reply(
    ctx,
    `Не буду звать тебя в новых /fort сборах до ${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} МСК.`,
  );
}
async function cmdRoast(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const parts = String(ctx.match ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  if (parts[0] === "off") {
    await db.set_feature(ctx.chat.id, "roast", false);
    await reply(ctx, "Режим язвительных ответов выключен.");
    return;
  }
  if (parts[0] === "on") {
    const probability = parts.length > 1 ? Number(parts[1]) : null;
    if (probability !== null && Number.isNaN(probability)) {
      await reply(
        ctx,
        "Вероятность должна быть числом от 0 до 1, например: /roast on 0.15",
      );
      return;
    }
    if (probability !== null && !(probability > 0 && probability <= 1)) {
      await reply(
        ctx,
        "Вероятность должна быть в диапазоне (0, 1], например: /roast on 0.15",
      );
      return;
    }
    await db.set_feature(ctx.chat.id, "roast", true, probability);
    await reply(
      ctx,
      `Режим язвительных ответов включён. Вероятность: ${probability !== null ? probability.toFixed(2) : `${roast.ROAST_PROBABILITY.toFixed(2)} (по умолчанию)`}`,
    );
    return;
  }
  await reply(ctx, "Использование: /roast on [вероятность 0-1] или /roast off");
}
async function cmdLinkepicfor(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  if (!ADMIN_USER_ID) {
    await reply(ctx, "Админ-линковка не настроена.");
    return;
  }
  if (ctx.from.id !== ADMIN_USER_ID) {
    await reply(ctx, "Команда только для админа бота.");
    return;
  }
  if (!fortnite.isConfigured()) {
    await reply(ctx, "Fortnite-статистика не настроена.");
    return;
  }
  const match = /^(@\S+)\s+(.+)$/.exec(String(ctx.match ?? "").trim());
  if (!match || match[1]!.length < 2 || match[2]!.length > 32) {
    await reply(ctx, "Формат: /linkepicfor @username EpicName");
    return;
  }
  const resolved = await db.resolve_user_by_username(ctx.chat.id, match[1]!);
  if (!resolved) {
    await reply(
      ctx,
      `Не нашёл ${escapeHtml(match[1]!)} среди тех, кто отвечал на /fort в этом чате. Попроси его сначала ткнуть кнопку в /fort.`,
    );
    return;
  }
  const [userId, name] = resolved;
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  let epicName: string,
    epicId: string,
    empty = false;
  try {
    const stats = await fortnite.fetchStats({ name: match[2]!.trim() });
    epicName = stats.epic_name;
    epicId = stats.epic_account_id;
  } catch (error) {
    if (error instanceof fortnite.StatsEmpty) {
      epicName = error.epic_name;
      epicId = error.epic_account_id;
      empty = true;
    } else if (error instanceof fortnite.FortniteError) {
      await reply(ctx, epicErrorText(error));
      return;
    } else throw error;
  }
  await db.save_epic_link(ctx.chat.id, userId, name, epicName, epicId);
  await reply(
    ctx,
    `✅ <a href="tg://user?id=${userId}">${escapeHtml(name)}</a> → Epic <b>${escapeHtml(epicName)}</b> (залинковал админ${empty ? ", у игрока ещё 0 матчей" : ""})`,
  );
}
async function cmdMyfnstats(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  if (!fortnite.isConfigured()) {
    await reply(ctx, "Fortnite-статистика не настроена.");
    return;
  }
  const link = await db.get_epic_link(ctx.chat.id, ctx.from.id);
  if (!link) {
    await reply(
      ctx,
      "Тебя ещё не залинковали. Попроси админа: /linkepicfor @твой_ник EpicName",
    );
    return;
  }
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  let stats;
  try {
    stats = await fortnite.fetchStats({
      account_id: link.epic_account_id,
      with_image: true,
    });
  } catch (error) {
    if (!(error instanceof fortnite.FortniteError)) throw error;
    await reply(ctx, epicErrorText(error));
    return;
  }
  if (stats.image_url) {
    try {
      await ctx.replyWithPhoto(stats.image_url, {
        caption: messages.myFnCaption(link, stats),
      });
      return;
    } catch (error) {
      if (!(error instanceof GrammyError)) throw error;
    }
  }
  await reply(ctx, messages.buildMyFnStatsText(link, stats));
}

export type TeamDelta = [number, number, number, number];
type Success = [db.EpicLink, fortnite.PlayerStats];
export async function computeTeamDeltas(
  successes: Success[],
  now: number,
): Promise<[Map<string, TeamDelta>, Map<string, TeamDelta>]> {
  const daily = new Map<string, TeamDelta>(),
    weekly = new Map<string, TeamDelta>();
  for (const [, stats] of successes) {
    if (!stats.overall?.matches) continue;
    const current = stats.overall;
    const deaths =
      current.kd > 0 ? messages.roundEven(current.kills / current.kd) : 0;
    for (const [window, age, target] of [
      [86400, 129600, daily],
      [604800, 864000, weekly],
    ] as const) {
      const previous = await db.get_snapshot_before(
        stats.epic_account_id,
        now - window,
        now - age,
      );
      if (
        !previous ||
        previous.overall_matches == null ||
        previous.overall_wins == null ||
        previous.overall_kills == null ||
        previous.overall_deaths_est == null
      )
        continue;
      const matches = current.matches - previous.overall_matches;
      if (matches < 0) continue;
      const kills = current.kills - previous.overall_kills,
        deltaDeaths = deaths - previous.overall_deaths_est;
      target.set(stats.epic_account_id, [
        matches,
        current.wins - previous.overall_wins,
        kills,
        deltaDeaths > 0 ? kills / deltaDeaths : 0,
      ]);
    }
  }
  return [daily, weekly];
}
export function buildWeeklyView(
  successes: Success[],
  deltas: Map<string, TeamDelta>,
): [Success[], [db.EpicLink, string][]] {
  const weekly: Success[] = [],
    missing: [db.EpicLink, string][] = [];
  for (const [link, stats] of successes) {
    const delta = deltas.get(stats.epic_account_id);
    if (!delta) {
      missing.push([link, "нет данных за неделю"]);
      continue;
    }
    const [matches, wins, kills, kd] = delta;
    if (!matches) {
      missing.push([link, "не играл за неделю"]);
      continue;
    }
    const mode = {
      matches,
      wins,
      kills,
      kd,
      win_rate: wins / matches,
      minutes_played: 0,
    };
    weekly.push([
      link,
      { ...stats, overall: mode, solo: null, duo: null, squad: mode },
    ]);
  }
  return [weekly, missing];
}
export async function runTeamstats(
  bot: Bot,
  chat: number,
  silentOnEmpty = false,
): Promise<void> {
  if (!fortnite.isConfigured()) {
    if (!silentOnEmpty)
      await bot.api.sendMessage(chat, "Fortnite-статистика не настроена.");
    return;
  }
  const links = await db.get_chat_epic_links(chat);
  if (!links.length) {
    if (!silentOnEmpty)
      await bot.api.sendMessage(
        chat,
        "Никто не залинкован. Админ может это сделать через /linkepicfor.",
      );
    return;
  }
  await bot.api.sendChatAction(chat, "typing");
  const successes: Success[] = [],
    failures: [db.EpicLink, fortnite.FortniteError][] = [];
  for (const link of links) {
    try {
      successes.push([
        link,
        await fortnite.fetchStats({
          account_id: link.epic_account_id,
          with_image: false,
        }),
      ]);
    } catch (error) {
      if (!(error instanceof fortnite.FortniteError)) throw error;
      failures.push([link, error]);
    }
  }
  const now = await valueCheckpoint("teamstats-time", nowSeconds);
  const [daily, weekly] = await computeTeamDeltas(successes, now);
  const [view, missing] = buildWeeklyView(successes, weekly);
  if (!view.length) {
    if (!silentOnEmpty)
      await bot.api.sendMessage(
        chat,
        "Пока нет недельных данных — копим снапшоты, загляни позже.",
      );
    return;
  }
  const [baseHtml, facts] = messages.buildTeamFnStatsText(view, failures, {
    weekly_missing: missing,
    deltas_24h: daily,
  });
  let html = baseHtml;
  if (facts) {
    const analysis = await externalCheckpoint("team-roast", () =>
      roast.generateTeamStatsRoast(facts),
    );
    if (analysis) html = appendTeamAnalysis(html, analysis);
  }
  await bot.api.sendMessage(chat, html);
}
async function onCallback(ctx: Context): Promise<void> {
  const callback = ctx.callbackQuery;
  if (!callback?.message || !ctx.from) {
    await ctx.answerCallbackQuery();
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
    await ctx.answerCallbackQuery("Сбор устарел");
    return;
  }
  if (session.is_closed) {
    await ctx.answerCallbackQuery("Сбор завершён.");
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
      await ctx.answerCallbackQuery("Слот недоступен.");
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
    await ctx.answerCallbackQuery("Ты уже в деле!");
    return;
  }
  if (action === "pass" && session.pass_players.has(id)) {
    await ctx.answerCallbackQuery("Ты уже в списке пасующих.");
    return;
  }
  if (
    action === "go" &&
    !alreadyGo &&
    session.go_players.size >= messages.SQUAD_SIZE + messages.RESERVE_SIZE
  ) {
    await ctx.answerCallbackQuery("Резерв заполнен.");
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
    await ctx.answerCallbackQuery(
      `Сквад полон — ты в резерве №${[...reserve.keys()].indexOf(id) + 1}.`,
    );
  else await ctx.answerCallbackQuery();
}
async function maybeRoast(ctx: Context): Promise<void> {
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
    await setSessionPin(bot, session, false);
    db.getSessions().delete(key(session.chat_id, session.message_id));
    expired.push(session.message_id);
  }
  return expired;
}
export function registerHandlers(bot: Bot): void {
  const commands: Record<string, (ctx: Context) => Promise<void>> = {
    fort: cmdFort,
    fortemoji: cmdFortemoji,
    afk: cmdAfk,
    roast: cmdRoast,
    linkepicfor: cmdLinkepicfor,
    myfnstats: cmdMyfnstats,
    stats: async (ctx) => {
      if (ctx.chat)
        await reply(
          ctx,
          messages.buildStatsText(
            await db.get_chat_stats(ctx.chat.id),
            await valueCheckpoint("stats-style", messages.randomStatsStyle),
          ),
        );
    },
    teamstats: async (ctx) => {
      if (ctx.chat) await runTeamstats(bot, ctx.chat.id);
    },
    rm: async (ctx) => {
      const active = [...db.getSessions().values()].find(
        (session) => session.chat_id === ctx.chat?.id && !session.is_closed,
      );
      if (active) await closeSession(bot, active, true);
      await ignoreTelegram(() => ctx.deleteMessage());
    },
  };
  for (const [command, handler] of Object.entries(commands))
    bot.command(command, async (ctx) => {
      if (!isGroup(ctx)) {
        await reply(ctx, GROUP_ONLY);
        return;
      }
      await handler(ctx);
    });
  bot.callbackQuery(/^(go|pass|slot:.*)$/, onCallback);
  bot.on("message:new_chat_members", async (ctx) => {
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot && member.id !== ctx.me.id) continue;
      const mention =
        member.id === ctx.me.id
          ? "всем"
          : `<a href="tg://user?id=${member.id}">${escapeHtml(displayName(member))}</a>`;
      await ignoreTelegram(() =>
        ctx.reply(
          `👋 Привет, ${mention}.\n\nЯ бот для сбора скуада в Fortnite. Команды:\n🎮 /fort — собрать отряд из 4 человек\n🗑 /rm — отменить активный сбор\n📊 /stats — статистика чата\n\nТакже слежу за статусом серверов Epic и предупрежу, если они недоступны.`,
        ),
      );
    }
  });
  bot.on("message:text", maybeRoast);
}
