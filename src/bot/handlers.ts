import { gtaRoast } from "./services/gta";
import { valueCheckpoint } from "./work";
import {
  archiveMessage,
  usesConversation,
} from "./services/conversation-store";
import {
  approveChat,
  isChatApproved,
  isGeneralAdmin,
} from "./services/chat-access";
import type { Bot, Context } from "grammy";
import {
  GROUP_ONLY,
  answerCallback,
  displayName,
  escapeHtml,
  ignoreTelegram,
  isGroup,
  reply,
  nowSeconds,
} from "./handlers/common";
import { cmdLinkepicfor, runStats } from "./handlers/stats";
import { maybeRoast } from "./handlers/roast";

export { displayName, escapeHtml } from "./handlers/common";
export { appendTeamAnalysis, runStats } from "./handlers/stats";
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
    fort: async (ctx) => {
      const now = await valueCheckpoint("gta-redirect-time-v1", nowSeconds);
      await reply(ctx, gtaRoast(now));
    },
    linkepicfor: cmdLinkepicfor,
    stats: async (ctx) => {
      if (ctx.chat) await runStats(bot, ctx.chat.id);
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
    async (ctx) => {
      await answerCallback(ctx, "Сборы отключены. Идите играть в GTA 6!");
      await ignoreTelegram(() =>
        ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }),
      );
    },
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
          `👋 Привет, ${mention}. Идите нахер играть в GTA 6 вместо фортика!\n\n📊 /stats — результаты Fortnite за неделю. Сборы отключены.`,
        ),
      );
    }
  });
  bot.on(["message:text", "message:caption"], async (ctx) => {
    if (ctx.message?.text?.startsWith("/")) return;
    await maybeRoast(ctx);
  });
}
