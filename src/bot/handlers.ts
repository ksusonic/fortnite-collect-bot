import {
  approveChat,
  isChatApproved,
  isGeneralAdmin,
} from "./services/chat-access";
import { statisticsKeyboard } from "./mini-app-link";
import type { Bot, Context } from "grammy";
import * as db from "./db";
import * as messages from "./messages";
import { valueCheckpoint } from "./work";
import {
  GROUP_ONLY,
  displayName,
  escapeHtml,
  ignoreTelegram,
  isGroup,
  reply,
} from "./handlers/common";
import { closeSession, cmdFort, onCallback } from "./handlers/gatherings";
import { cmdAfk } from "./handlers/settings";
import { cmdLinkepicfor, runTeamstats } from "./handlers/stats";
import { maybeRoast } from "./handlers/roast";

// Keep the public entrypoint stable for runtime and callers during the feature split.
export { displayName, escapeHtml } from "./handlers/common";
export { parseTargetHour, sweep_expired_sessions } from "./handlers/gatherings";
export { appendTeamAnalysis, runTeamstats } from "./handlers/stats";
export {
  buildWeeklyView,
  computeTeamDeltas,
  type TeamDelta,
} from "./services/weekly-stats";

export function registerHandlers(bot: Bot): void {
  // Deliberately absent from all public command menus.
  bot.command("init", async (ctx) => {
    if (
      !isGroup(ctx) ||
      ctx.message?.sender_chat ||
      ctx.from?.is_bot ||
      !isGeneralAdmin(ctx.from?.id)
    )
      return;
    await approveChat(ctx.chat!.id, ctx.from!.id);
    await reply(ctx, "✅ Бот включён в этом чате.");
  });
  bot.use(async (ctx, next) => {
    if (!isGroup(ctx) || !ctx.chat || !(await isChatApproved(ctx.chat.id)))
      return;
    await next();
  });

  const commands: Record<string, (ctx: Context) => Promise<void>> = {
    fort: cmdFort,
    afk: cmdAfk,
    linkepicfor: cmdLinkepicfor,
    stats: async (ctx) => {
      if (ctx.chat)
        await ctx.reply(
          messages.buildStatsText(
            await db.get_chat_stats(ctx.chat.id),
            await valueCheckpoint("stats-style", messages.randomStatsStyle),
          ),
          { reply_markup: statisticsKeyboard(ctx.chat.id) },
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
