import type { Context } from "grammy";
import * as db from "../db";
import { valueCheckpoint } from "../work";
import { mskDate, nowSeconds, reply } from "./common";

export async function cmdAfk(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  const arg = String(ctx.match ?? "")
    .trim()
    .toLowerCase();
  if (arg === "off") {
    await db.clear_afk(ctx.chat.id, ctx.from.id);
    await reply(ctx, "Снова буду звать тебя в новых /fort сборах.");
    return;
  }
  const match = /^([1-9]\d{0,3})([dw])$/.exec(arg);
  if (!match) {
    await reply(ctx, "Использование: /afk 1d, /afk 2w или /afk off");
    return;
  }
  const until = await valueCheckpoint(
    "afk-until",
    () => nowSeconds() + Number(match[1]) * (match[2] === "w" ? 7 : 1) * 86400,
  );
  await db.set_afk(ctx.chat.id, ctx.from.id, until);
  const date = mskDate(until);
  const pad = (value: number) => String(value).padStart(2, "0");
  await reply(
    ctx,
    `Не буду звать тебя в новых /fort сборах до ${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} МСК.`,
  );
}
