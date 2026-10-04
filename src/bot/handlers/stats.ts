import { statisticsKeyboard } from "../mini-app-link";
import type { Bot, Context } from "grammy";
import * as db from "../db";
import * as fortnite from "../fortnite";
import * as messages from "../messages";
import * as roast from "../roast";
import { externalCheckpoint, valueCheckpoint } from "../work";
import {
  buildWeeklyView,
  computeTeamDeltas,
  type TeamStatsSuccess,
} from "../services/weekly-stats";
import { escapeHtml, nowSeconds, reply } from "./common";

import { isGeneralAdmin } from "../services/chat-access";

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
export async function cmdLinkepicfor(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  if (
    !Number.isSafeInteger(Number(process.env.ADMIN_USER_ID)) ||
    Number(process.env.ADMIN_USER_ID) <= 0
  ) {
    await reply(ctx, "Админ-линковка не настроена.");
    return;
  }
  if (!isGeneralAdmin(ctx.from.id)) {
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
  await db.save_epic_link(userId, name, epicName, epicId);
  await reply(
    ctx,
    `✅ <a href="tg://user?id=${userId}">${escapeHtml(name)}</a> → Epic <b>${escapeHtml(epicName)}</b> (залинковал админ${empty ? ", у игрока ещё 0 матчей" : ""})`,
  );
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
  const successes: TeamStatsSuccess[] = [],
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
  await bot.api.sendMessage(chat, html, {
    reply_markup: statisticsKeyboard(chat),
  });
}
