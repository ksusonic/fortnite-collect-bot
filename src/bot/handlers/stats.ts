import { statisticsKeyboard } from "../mini-app-link";
import type { Bot, Context } from "grammy";
import * as db from "../db";
import * as fortnite from "../fortnite";
import * as messages from "../messages";
import * as roast from "../roast";
import { externalCheckpoint, valueCheckpoint } from "../work";
import {
  buildWeeklyView,
  type TeamStatsSuccess,
} from "../services/weekly-stats";
import { computeLifetimeReport } from "../../statistics/weekly";
import { teamFacts } from "../../statistics/summary";
import { logEvent, errorFields } from "../logging";
import { escapeHtml, nowSeconds, reply } from "./common";

import { isGeneralAdmin } from "../services/chat-access";

export function appendTeamAnalysis(html: string, text: string): string {
  const header = "\n\n💬 <b>Grok</b>\n";
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
export async function runStats(bot: Bot, chat: number): Promise<void> {
  const now = await valueCheckpoint("stats-report-time", nowSeconds);
  const gatherings = await db.get_chat_stats(chat, {
    from: now - 604800,
    to: now,
  });
  const links = fortnite.isConfigured()
    ? await db.get_chat_epic_links(chat)
    : [];
  const successes: TeamStatsSuccess[] = [];
  const notices: [db.EpicLink, string][] = [];
  for (const link of links) {
    try {
      successes.push([
        link,
        await fortnite.fetchLifetimeStats(link.epic_account_id),
      ]);
    } catch (error) {
      if (!(error instanceof fortnite.FortniteError)) throw error;
      notices.push([
        link,
        error instanceof fortnite.EpicNameNotFound
          ? "👻 Epic-аккаунт не найден"
          : error instanceof fortnite.StatsPrivate
            ? "🔒 Профиль закрыт"
            : error instanceof fortnite.StatsEmpty
              ? "🎮 Пока нет матчей"
              : "🚧 Fortnite API временно недоступен",
      ]);
    }
  }
  const report = await computeLifetimeReport(successes, now);
  const [view, missing] = buildWeeklyView(
    successes,
    report.weekly,
    report.reasons,
  );
  notices.push(...missing);
  let html = messages.buildUnifiedStatsText({
    now,
    gatherings,
    successes,
    weeklyView: view,
    report,
    notices,
    status: !fortnite.isConfigured()
      ? "⚙️ Fortnite-статистика не настроена."
      : !links.length
        ? "🔗 Нет привязанных Epic-аккаунтов. Админ может добавить их через /linkepicfor."
        : !successes.length
          ? "🚧 Нет доступных игровых данных — причины ниже."
          : undefined,
  });
  const facts = teamFacts(view, {
    weekly_missing: missing,
    deltas_24h: report.daily,
  });
  if (facts) {
    // A model failure must not suppress the factual report. Cache the fallback too,
    // so replay follows the same branch and Telegram checkpoint order.
    const analysis = await externalCheckpoint("stats-analysis", async () => {
      try {
        return await roast.generateTeamStatsRoast(
          facts +
            "\nФактические периоды снимков:\n" +
            view
              .map(([link, stats]) => {
                const p = report.periods.get(stats.epic_account_id)!;
                return `${link.user_name}: ${messages.statsPeriod(p.baselineAt, p.fetchedAt)}`;
              })
              .join("\n"),
        );
      } catch (error) {
        logEvent("warn", "stats.analysis_failed", errorFields(error));
        return null;
      }
    });
    if (analysis) {
      const sentences = Array.from(
        new Intl.Segmenter("ru", { granularity: "sentence" }).segment(analysis),
        (part) => part.segment,
      )
        .slice(0, 2)
        .join("");
      html = appendTeamAnalysis(
        html,
        Array.from(sentences).slice(0, 400).join(""),
      );
    }
  }
  await bot.api.sendMessage(chat, html, {
    reply_markup: statisticsKeyboard(chat),
  });
}
