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
import type { Bot, Context } from "grammy";
import * as db from "./db";
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
  onCallback,
  maybeGatheringMessage,
} from "./handlers/gatherings";
import { cmdAfk } from "./handlers/settings";
import { cmdLinkepicfor, runStats } from "./handlers/stats";
import { maybeRoast } from "./handlers/roast";

// Keep the public entrypoint stable for runtime and callers during the feature split.
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
    fort: cmdFort,
    afk: cmdAfk,
    linkepicfor: cmdLinkepicfor,
    stats: async (ctx) => {
      if (ctx.chat) await runStats(bot, ctx.chat.id);
    },
    rm: async (ctx) => {
      const argument = String(ctx.match ?? "")
        .trim()
        .toLowerCase();
      if (argument && !["fort", "fortnite"].includes(argument)) {
        await reply(
          ctx,
          "Используй /rm fort или ответь /rm на карточку сбора.",
        );
        return;
      }
      const replyId = ctx.message?.reply_to_message?.message_id;
      const chat = ctx.chat!.id;
      const id = await valueCheckpoint(
        "cancel-gathering-id-v1",
        () =>
          [...db.getSessions().values()].find(
            (s) =>
              s.chat_id === chat &&
              !s.is_closed &&
              gatheringGame(s) === "fortnite" &&
              (argument !== "" ||
                replyId === undefined ||
                s.message_id === replyId),
          )?.message_id ?? null,
      );
      if (id !== null) {
        const session = await db.load_session(id, chat);
        if (session) await closeSession(bot, session, true);
      }
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
          `👋 Привет, ${mention}.\n\nЯ бот для сбора скуада в Fortnite. Команды:\n🎮 /fort — собрать отряд из 4 человек\n🗑 /rm — отменить сбор\n📊 /stats — сборы и результаты Fortnite за неделю\n\nТакже слежу за статусом серверов Epic и предупрежу, если они недоступны.`,
        ),
      );
    }
  });
  bot.on(["message:text", "message:caption"], async (ctx) => {
    if (ctx.message?.text?.startsWith("/")) return;
    if (!(await maybeGatheringMessage(ctx))) await maybeRoast(ctx);
  });
}
