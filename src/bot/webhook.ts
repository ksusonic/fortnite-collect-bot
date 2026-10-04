import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import { createBot } from "./runtime";
import { setupBotCommands } from "./commands";
import { raw } from "./storage";
import { httpSignal, scopedFetch, withHttpClient } from "./transport";

const allowedUpdates = ["message", "callback_query"] as const;

function webhookSettings(argument: string) {
  if (!argument) throw new Error("production URL required");
  const base = new URL(argument);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("production URL must be an HTTPS origin");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error("TELEGRAM_WEBHOOK_SECRET is not configured");
  return {
    url: new URL("/api/telegram/webhook", base).toString(),
    options: {
      secret_token: secret,
      max_connections: 1,
      allowed_updates: [...allowedUpdates],
      drop_pending_updates: false,
    },
  };
}

async function ensureWebhook(bot: Bot, argument: string, force = false) {
  const { url, options } = webhookSettings(argument);
  const matches = (info: Awaited<ReturnType<Bot["api"]["getWebhookInfo"]>>) =>
    info.url === url &&
    info.max_connections === options.max_connections &&
    allowedUpdates.every((update) => info.allowed_updates?.includes(update)) &&
    info.allowed_updates?.length === allowedUpdates.length;
  if (!force && matches(await bot.api.getWebhookInfo())) return;
  await bot.api.setWebhook(url, options);
  if (!matches(await bot.api.getWebhookInfo()))
    throw new Error("Telegram webhook verification failed");
}

/** Called at production Node instance startup; no database or job side effects. */
export function ensureStartupWebhook(bot: Bot): Promise<void> {
  return ensureWebhook(bot, process.env.PUBLIC_BASE_URL ?? "");
}

/** The first authenticated maintenance tick reconciles the stable webhook. */
export async function syncReleaseWebhook(bot: Bot): Promise<void> {
  const { url, options } = webhookSettings(process.env.PUBLIC_BASE_URL ?? "");
  const revision = `${process.env.VERCEL_GIT_COMMIT_SHA ?? "local"}:${createHash("sha256").update(JSON.stringify({ url, options })).digest("hex")}`;
  const prior = (
    await raw(
      "SELECT value FROM service_state WHERE key='telegram_webhook_release'",
    )
  ).rows[0]?.value;
  await ensureWebhook(
    bot,
    process.env.PUBLIC_BASE_URL ?? "",
    prior?.revision !== revision,
  );
  if (prior?.revision === revision) return;
  await raw(
    "INSERT INTO service_state(key,value) VALUES ('telegram_webhook_release',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [JSON.stringify({ revision })],
  );
}

export async function registerWebhook(argument: string) {
  return withHttpClient(async () => {
    const { url, options } = webhookSettings(argument);
    const response = await scopedFetch(new URL("/health", url), {
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
    await bot.api.setWebhook(url, options);
    return bot.api.getWebhookInfo();
  });
}
