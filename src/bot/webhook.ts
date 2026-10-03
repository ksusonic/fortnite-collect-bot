/** Explicit server maintenance; never register a webhook during startup. */
import { createBot } from "./runtime";
import { setupBotCommands } from "./commands";
import { httpSignal, scopedFetch, withHttpClient } from "./transport";

export async function registerWebhook(argument: string) {
  return withHttpClient(async () => {
    if (!argument) throw new Error("production URL required");
    const url = new URL(argument);
    if (url.protocol !== "https:")
      throw new Error("production URL must use HTTPS");
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
    const base = argument.replace(/\/+$/, "");
    const response = await scopedFetch(`${base}/health`, {
      signal: httpSignal(20_000),
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("production health check failed");
    }
    if (!((await response.json()) as { ok?: boolean }).ok)
      throw new Error("production health check failed");
    const bot = createBot();
    await setupBotCommands(bot);
    await bot.api.setWebhook(`${base}/api/telegram/webhook`, {
      secret_token: secret,
      max_connections: 1,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    return bot.api.getWebhookInfo();
  });
}
