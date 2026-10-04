import { GrammyError, type Bot, type Context } from "grammy";
import type { User } from "grammy/types";

export const GROUP_ONLY = "Эта команда работает только в группах.";
export type ApiBot = Pick<Bot, "api">;
export const nowSeconds = () => Date.now() / 1000;
export const key = (chat: number, message: number) => `${chat}:${message}`;
export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
export const displayName = (user: User) =>
  user.username ? `@${user.username}` : user.first_name || String(user.id);
export const mskDate = (seconds: number) => new Date((seconds + 10800) * 1000);
export function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}
export async function ignoreTelegram(
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
  }
}
export async function reply(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text);
}
