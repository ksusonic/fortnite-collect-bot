import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import { raw } from "./storage";

export const GROUP_COMMANDS = [
  { command: "fort", description: "собрать сквад на катку" },
  { command: "afk", description: "временно не звать в /fort: 1d, 2w или off" },
  { command: "rm", description: "отменить активный сбор" },
  { command: "stats", description: "статистика чата" },
  { command: "teamstats", description: "командная статистика Fortnite" },
];

export async function setupBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(GROUP_COMMANDS, {
    scope: { type: "all_group_chats" },
  });
  await bot.api.deleteMyCommands({ scope: { type: "all_private_chats" } });
  await bot.api.deleteMyCommands();
  const group = await bot.api.getMyCommands({
    scope: { type: "all_group_chats" },
  });
  const privateCommands = await bot.api.getMyCommands({
    scope: { type: "all_private_chats" },
  });
  const defaults = await bot.api.getMyCommands();
  if (
    JSON.stringify(group) !== JSON.stringify(GROUP_COMMANDS) ||
    privateCommands.length ||
    defaults.length
  )
    throw new Error("Telegram command menu verification failed");
}

/** Run from the authenticated maintenance job, never during startup or build. */
export async function syncReleaseCommands(bot: Bot): Promise<void> {
  const revision = `${process.env.VERCEL_GIT_COMMIT_SHA ?? "local"}:${createHash("sha256").update(JSON.stringify(GROUP_COMMANDS)).digest("hex")}`;
  const prior = (
    await raw(
      "SELECT value FROM service_state WHERE key='telegram_commands_release'",
    )
  ).rows[0]?.value;
  if (prior?.revision === revision) return;
  // These operations are idempotent; a failure before the marker safely retries next tick.
  await setupBotCommands(bot);
  await raw(
    "INSERT INTO service_state(key,value) VALUES ('telegram_commands_release',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [JSON.stringify({ revision })],
  );
}
