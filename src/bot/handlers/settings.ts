import { GrammyError, type Context } from "grammy";
import * as db from "../db";
import * as roast from "../roast";
import { valueCheckpoint } from "../work";
import { escapeHtml, mskDate, nowSeconds, reply } from "./common";

export async function cmdFortemoji(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
  if (member.status !== "creator" && member.status !== "administrator") {
    await reply(
      ctx,
      "Настроить заголовок сбора может только администратор чата.",
    );
    return;
  }
  if (ctx.match === "off") {
    await db.set_fort_title(ctx.chat.id, null);
    await reply(ctx, "В новых сборах будет обычный заголовок 🎮 FORT.");
    return;
  }
  const source = ctx.message?.reply_to_message;
  const entities = (source?.entities ?? source?.caption_entities ?? [])
    .filter((entity) => entity.type === "custom_emoji")
    .sort((a, b) => a.offset - b.offset);
  if (entities.length !== 4) {
    await reply(
      ctx,
      "Напиши FORT четырьмя emoji из WideABC и ответь на это сообщение командой /fortemoji. Отключить: /fortemoji off.",
    );
    return;
  }
  let pack;
  try {
    pack = await ctx.api.getStickerSet("WideABC");
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    await reply(ctx, "Не удалось проверить WideABC. Попробуй ещё раз позже.");
    return;
  }
  const ids = new Set(pack.stickers.map((sticker) => sticker.custom_emoji_id));
  if (entities.some((entity) => !ids.has(entity.custom_emoji_id))) {
    await reply(
      ctx,
      "Все четыре буквы должны быть emoji из набора https://t.me/addemoji/WideABC.",
    );
    return;
  }
  const text = source?.text ?? source?.caption ?? "";
  const title = entities
    .map(
      (entity) =>
        `<tg-emoji emoji-id="${entity.custom_emoji_id}">${escapeHtml(text.slice(entity.offset, entity.offset + entity.length))}</tg-emoji>`,
    )
    .join("");
  try {
    await reply(ctx, `Заголовок новых сборов: ${title}`);
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    await reply(
      ctx,
      "Telegram не принял custom emoji. Проверь Premium у владельца бота.",
    );
    return;
  }
  await db.set_fort_title(ctx.chat.id, title);
}
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
export async function cmdRoast(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  const parts = String(ctx.match ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/);
  if (parts[0] === "off") {
    await db.set_feature(ctx.chat.id, "roast", false);
    await reply(ctx, "Режим язвительных ответов выключен.");
    return;
  }
  if (parts[0] === "on") {
    const probability = parts.length > 1 ? Number(parts[1]) : null;
    if (probability !== null && Number.isNaN(probability)) {
      await reply(
        ctx,
        "Вероятность должна быть числом от 0 до 1, например: /roast on 0.15",
      );
      return;
    }
    if (probability !== null && !(probability > 0 && probability <= 1)) {
      await reply(
        ctx,
        "Вероятность должна быть в диапазоне (0, 1], например: /roast on 0.15",
      );
      return;
    }
    await db.set_feature(ctx.chat.id, "roast", true, probability);
    await reply(
      ctx,
      `Режим язвительных ответов включён. Вероятность: ${probability !== null ? probability.toFixed(2) : `${roast.ROAST_PROBABILITY.toFixed(2)} (по умолчанию)`}`,
    );
    return;
  }
  await reply(ctx, "Использование: /roast on [вероятность 0-1] или /roast off");
}
