import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import { httpSignal } from "./transport";
import { logEvent, errorFields } from "./logging";
import { raw, advisoryLock } from "./storage";

export const GROUP_COMMANDS = [
  { command: "fort", description: "собрать сквад на катку" },
  { command: "warcraft", description: "собрать отряд в Warcraft" },
  { command: "afk", description: "AFK себе или @user: 1d, 2w или off" },
  { command: "rm", description: "отменить сбор: fort или warcraft" },
  { command: "stats", description: "📊 сборы и Fortnite за неделю" },
];

export async function setupBotCommands(bot: Bot): Promise<void> {
  const signal = httpSignal(20_000) as unknown as Parameters<
    Bot["api"]["getMyCommands"]
  >[1];
  await bot.api.setMyCommands(
    GROUP_COMMANDS,
    {
      scope: { type: "all_group_chats" },
    },
    signal,
  );
  await bot.api.deleteMyCommands(
    { scope: { type: "all_private_chats" } },
    signal,
  );
  await bot.api.deleteMyCommands({}, signal);
  const group = await bot.api.getMyCommands(
    {
      scope: { type: "all_group_chats" },
    },
    signal,
  );
  const privateCommands = await bot.api.getMyCommands(
    {
      scope: { type: "all_private_chats" },
    },
    signal,
  );
  const defaults = await bot.api.getMyCommands({}, signal);
  if (
    JSON.stringify(group) !== JSON.stringify(GROUP_COMMANDS) ||
    privateCommands.length ||
    defaults.length
  )
    throw new Error("Telegram command menu verification failed");
}

/** Awaited at runtime initialization and maintenance, never at import/build time. */
export async function syncReleaseCommands(bot: Bot): Promise<void> {
  const revision = `${process.env.VERCEL_GIT_COMMIT_SHA ?? "local"}:${createHash("sha256").update(JSON.stringify(GROUP_COMMANDS)).digest("hex")}`;
  const matches = async () =>
    (
      await raw(
        "SELECT value FROM service_state WHERE key='telegram_commands_release'",
      )
    ).rows[0]?.value?.revision === revision;
  if (await matches()) return;
  await advisoryLock(
    "telegram:commands",
    async () => {
      if (await matches()) return;
      await setupBotCommands(bot);
      await raw(
        "INSERT INTO service_state(key,value) VALUES ('telegram_commands_release',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify({ revision })],
      );
    },
    false,
  );
}
export async function ensureReleaseCommands(bot: Bot): Promise<void> {
  try {
    await syncReleaseCommands(bot);
  } catch (error) {
    logEvent("warn", "telegram.commands_sync_failed", errorFields(error));
  }
}
