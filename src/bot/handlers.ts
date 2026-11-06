import {
  archiveMessage,
  usesConversation,
} from "./services/conversation-store";
import {
  approveChat,
  isChatApproved,
  isGeneralAdmin,
} from "./services/chat-access";
import { gatheringGame } from "./services/gathering";
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
import {
  closeSession,
  cmdFort,
  cmdWarcraft,
  onCallback,
  maybeGatheringMessage,
} from "./handlers/gatherings";
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
    if (usesConversation()) await archiveMessage(ctx);
    await next();
  });

  const commands: Record<string, (ctx: Context) => Promise<void>> = {
    fort: cmdFort,
    warcraft: cmdWarcraft,
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
      const argument = String(ctx.match ?? "")
        .trim()
        .toLowerCase();
      if (argument && !["fort", "fortnite", "warcraft"].includes(argument)) {
        await reply(
          ctx,
          "Используй /rm fort или /rm warcraft, либо ответь /rm на карточку сбора.",
        );
        return;
      }
      const candidates = [...db.getSessions().values()].filter(
        (s) => s.chat_id === ctx.chat?.id && !s.is_closed,
      );
      const replyId = ctx.message?.reply_to_message?.message_id;
      const selected = argument
        ? candidates.filter(
            (s) =>
              gatheringGame(s) ===
              (argument === "warcraft" ? "warcraft" : "fortnite"),
          )
        : replyId !== undefined
          ? candidates.filter((s) => s.message_id === replyId)
          : candidates;
      if (selected.length > 1) {
        await reply(
          ctx,
          "Открыты два сбора. Укажи /rm fort или /rm warcraft, либо ответь /rm на нужную карточку.",
        );
        return;
      }
      if (selected[0]) await closeSession(bot, selected[0], true);
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
  bot.callbackQuery(
    /^(go|pass|slot:.*|gready(?::\d+)?|gtime|gat:.*|gslot:.*|gconfirm:.*|gdismiss:.*)$/,
    onCallback,
  );
  bot.on("message:new_chat_members", async (ctx) => {
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot && member.id !== ctx.me.id) continue;
      const mention =
        member.id === ctx.me.id
          ? "всем"
          : `<a href="tg://user?id=${member.id}">${escapeHtml(displayName(member))}</a>`;
      await ignoreTelegram(() =>
        ctx.reply(
          `👋 Привет, ${mention}.\n\nЯ бот для сбора скуада в Fortnite. Команды:\n🎮 /fort — собрать отряд из 4 человек\n⚔️ /warcraft — собрать отряд в Warcraft\n🗑 /rm fort или /rm warcraft — отменить сбор\n📊 /stats — статистика чата\n\nТакже слежу за статусом серверов Epic и предупрежу, если они недоступны.`,
        ),
      );
    }
  });
  bot.on(["message:text", "message:caption"], async (ctx) => {
    if (!(await maybeGatheringMessage(ctx))) await maybeRoast(ctx);
  });
}
