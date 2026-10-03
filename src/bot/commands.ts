import type { Bot } from "grammy";

export const GROUP_COMMANDS = [
  { command: "fort", description: "собрать сквад на катку" },
  {
    command: "fortemoji",
    description: "настроить emoji-заголовок FORT (для админов)",
  },
  { command: "afk", description: "временно не звать в /fort: 1d, 2w или off" },
  { command: "rm", description: "отменить активный сбор" },
  { command: "stats", description: "статистика чата" },
  {
    command: "roast",
    description: "вкл/выкл язвительные ответы: on [0..1] | off",
  },
  { command: "myfnstats", description: "моя статистика Fortnite" },
  { command: "teamstats", description: "командная статистика Fortnite" },
];

export async function setupBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(GROUP_COMMANDS, {
    scope: { type: "all_group_chats" },
  });
  await bot.api.deleteMyCommands({ scope: { type: "all_private_chats" } });
  await bot.api.deleteMyCommands();
}
