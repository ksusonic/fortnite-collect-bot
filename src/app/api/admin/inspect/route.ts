import "server-only";
import { adminAuth, endpoint } from "@/bot/http";
import { withHttpClient } from "@/bot/transport";
import { createBot } from "@/bot/runtime";
import { invocation, raw } from "@/bot/storage";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  return endpoint(() =>
    withHttpClient(async () => {
      adminAuth(request);
      const data = await invocation(null, async () => ({
        chats: (
          await raw("SELECT DISTINCT chat_id FROM sessions ORDER BY chat_id")
        ).rows,
        work: (
          await raw(
            "SELECT status,count(*) AS count FROM work_items GROUP BY status",
          )
        ).rows,
      }));
      const bot = createBot();
      const me = await bot.api.getMe();
      const memberships = [];
      for (const row of data.chats) {
        try {
          const member = await bot.api.getChatMember(row.chat_id, me.id);
          memberships.push({ chat_id: row.chat_id, ...member });
        } catch (error) {
          memberships.push({
            chat_id: row.chat_id,
            error: error instanceof Error ? error.name : "Error",
          });
        }
      }
      return {
        bot: {
          id: me.id,
          username: me.username,
          can_read_all_group_messages: me.can_read_all_group_messages,
        },
        webhook: await bot.api.getWebhookInfo(),
        memberships,
        work: data.work,
        commands: await bot.api.getMyCommands({
          scope: { type: "all_group_chats" },
        }),
      };
    }),
  );
}
