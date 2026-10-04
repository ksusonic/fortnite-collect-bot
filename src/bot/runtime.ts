import * as Sentry from "@sentry/nextjs";
import { diagnosticTags } from "../sentry-options";
import { httpSignal, scopedFetch } from "./transport";
import { Bot, BotError, type ApiClientOptions } from "grammy";
import type { Update } from "grammy/types";
import * as db from "./db";
import { weeklyDue } from "./schedule-time";
import { executeSnapshot } from "./snapshots";
import { isChatApproved, isOwnerInit } from "./services/chat-access";
import {
  registerHandlers,
  runTeamstats,
  sweep_expired_sessions,
} from "./handlers";
import {
  advisoryLock,
  current,
  getRoastState,
  invocation,
  raw,
  withWork,
  type RoastEntry,
} from "./storage";
import { AmbiguousOutcome, telegramTransformer, Work } from "./work";

export function createBot(): Bot {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not configured");
  const bot = new Bot(token, {
    client: {
      timeoutSeconds: 30,
      fetch: scopedFetch as unknown as ApiClientOptions["fetch"],
    },
  });
  bot.api.config.use((previous, method, payload, signal) => {
    if (
      ["sendMessage", "editMessageText", "sendPhoto"].includes(method) &&
      !("parse_mode" in payload)
    ) {
      Object.assign(payload, { parse_mode: "HTML" });
    }
    return previous(method, payload, signal);
  });
  bot.api.config.use(telegramTransformer);
  registerHandlers(bot);
  return bot;
}
export async function initializeBot(bot: Bot): Promise<void> {
  if (bot.isInited()) return;
  // Bot.init retries network errors indefinitely. Serverless retries belong to
  // the durable queue, so fetch metadata once with a bounded deadline instead.
  // grammY types use its older AbortSignal shim; native signals expose the
  // same add/removeEventListener interface used by its API client.
  bot.botInfo = await bot.api.getMe(
    httpSignal(20_000) as unknown as Parameters<Bot["api"]["getMe"]>[0],
  );
}
export function updateChat(update: Update): number | null {
  if (update.message) return update.message.chat.id;
  if (update.edited_message) return update.edited_message.chat.id;
  if (update.my_chat_member) return update.my_chat_member.chat.id;
  if (update.chat_member) return update.chat_member.chat.id;
  if (update.callback_query)
    return update.callback_query.message?.chat.id ?? null;
  return null;
}
export function validateUpdate(value: unknown): asserts value is Update {
  if (
    !value ||
    typeof value !== "object" ||
    !("update_id" in value) ||
    !Number.isSafeInteger(value.update_id) ||
    Number(value.update_id) < 0
  )
    throw new Error("invalid update");
  for (const type of [
    "message",
    "edited_message",
    "callback_query",
    "my_chat_member",
    "chat_member",
  ]) {
    if (
      type in value &&
      (!value[type as keyof typeof value] ||
        typeof value[type as keyof typeof value] !== "object")
    )
      throw new Error("invalid update");
  }
}
export async function enqueue(
  id: string,
  kind: string,
  chat: number | null,
  payload: unknown,
) {
  await raw(
    "INSERT INTO work_items(id,kind,chat_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
    [id, kind, chat, JSON.stringify(payload)],
  );
}
async function hydrate(chat: number | null) {
  if (chat === null) return;
  for (const session of await db.load_active_sessions(chat))
    db.getSessions().set(`${session.chat_id}:${session.message_id}`, session);
  for (const [cid, history, messages, last] of await db.load_all_roast_state(
    chat,
  )) {
    Object.assign(getRoastState(cid), {
      history: history as RoastEntry[],
      message_ids: messages,
      last_roast: last,
    });
  }
}
interface Item {
  id: string;
  kind: string;
  chat_id: number | null;
  status: string;
  payload: Record<string, unknown>;
}
export async function executeItem(item: Item, bot: Bot): Promise<string> {
  const approved =
    item.chat_id !== null
      ? await isChatApproved(item.chat_id)
      : item.kind === "snapshot"
        ? !!(
            await raw(
              "SELECT 1 FROM epic_links l JOIN responses r ON r.user_id=l.user_id AND NOT r.is_bot JOIN approved_chats a ON a.chat_id=r.chat_id WHERE l.epic_account_id=$1 LIMIT 1",
              [item.payload.account_id],
            )
          ).rows.length
        : false;
  const ownerInit =
    item.kind === "update" && isOwnerInit(item.payload as unknown as Update);
  if (!approved && !ownerInit) {
    // Retire only unstarted work. Existing checkpoints/ambiguous outcomes remain for review.
    const retired = await raw(
      "UPDATE work_items w SET status='complete',error='chat not approved',updated_at=now() WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM work_steps s WHERE s.work_id=w.id) RETURNING id",
      [item.id],
    );
    return retired.rows.length ? "complete" : "failed";
  }

  await raw(
    "UPDATE work_items SET attempts=attempts+1,updated_at=now() WHERE id=$1",
    [item.id],
  );
  try {
    await withWork(new Work(item.id), async () => {
      if (item.kind !== "snapshot") await hydrate(item.chat_id);
      if (item.kind === "update")
        await bot.handleUpdate(item.payload as unknown as Update);
      else if (item.kind === "expiry")
        await sweep_expired_sessions(
          bot,
          Number(item.payload.now),
          Boolean(item.payload.past_deadline),
        );
      else if (item.kind === "weekly") {
        const last = await db.get_last_weekly_drop(item.chat_id!);
        if (last === null || last <= Number(item.payload.now) - 6 * 86400) {
          await runTeamstats(bot, item.chat_id!, true);
          await db.set_last_weekly_drop(
            item.chat_id!,
            Number(item.payload.now),
          );
        }
      } else if (item.kind === "snapshot") await executeSnapshot(item.payload);
      else if (item.kind === "status")
        await bot.api.sendMessage(item.chat_id!, String(item.payload.text));
      else throw new Error("unknown work kind");
      if (item.chat_id !== null) {
        const state = getRoastState(item.chat_id);
        await db.save_roast_state(
          item.chat_id,
          state.history,
          state.message_ids,
          state.last_roast,
        );
      }
    });
    await raw(
      "UPDATE work_items SET status='complete',error=NULL,updated_at=now() WHERE id=$1",
      [item.id],
    );
    return "complete";
  } catch (error) {
    if (error instanceof BotError) error = error.error;
    if (error instanceof AmbiguousOutcome) {
      Sentry.captureMessage("Uncertain Telegram send requires review", {
        level: "warning",
        tags: { component: "bot", work_kind: item.kind },
      });
      return "ambiguous";
    }
    Sentry.captureException(error, {
      tags: {
        component: "bot",
        work_kind: item.kind,
        ...diagnosticTags(error),
      },
    });
    console.error(
      "work failed",
      item.id,
      error instanceof Error ? error.name : "Error",
    );
    await raw(
      "UPDATE work_items SET status='failed',error=$1,updated_at=now() WHERE id=$2",
      [error instanceof Error ? error.name : "Error", item.id],
    );
    return "failed";
  }
}
export async function drainChat(
  chat: number | null,
  bot: Bot,
  signal?: AbortSignal,
): Promise<string> {
  return invocation(
    chat,
    async () => {
      return (
        (await advisoryLock(
          `chat:${chat === null ? "None" : chat}`,
          async () => {
            await initializeBot(bot);
            const rows = (
              await raw<Item>(
                "SELECT * FROM work_items WHERE chat_id IS NOT DISTINCT FROM $1 AND kind NOT IN ('job','snapshot') AND status<>'complete' ORDER BY created_at,id LIMIT 20",
                [chat],
              )
            ).rows;
            for (const item of rows) {
              if (item.status === "ambiguous") return "ambiguous";
              // Retire obsolete unstarted work under the chat lock. Started
              // work must replay its original checkpoints, including sends.
              const retired = await raw(
                `UPDATE work_items w SET status='complete',error=NULL,updated_at=now()
                 WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM work_steps s WHERE s.work_id=w.id)
                 AND ((kind='weekly' AND (payload->>'now')::double precision < $2)
                   OR (kind='expiry' AND NOT EXISTS (SELECT 1 FROM sessions s
                     WHERE s.chat_id=w.chat_id AND NOT s.is_closed
                     AND EXTRACT(EPOCH FROM s.created_at) <= (w.payload->>'now')::double precision)))
                 RETURNING id`,
                [item.id, weeklyDue(Date.now() / 1000).now],
              );
              if (retired.rows.length) continue;
              const result = await executeItem(item, bot);
              if (result !== "complete") return result;
            }
            return "complete";
          },
          // Another invocation owns this causal queue; leave its work untouched.
          false,
        )) ?? "busy"
      );
    },
    signal,
  );
}
export async function processUpdate(
  payload: unknown,
  signal?: AbortSignal,
): Promise<string> {
  validateUpdate(payload);
  const chat = updateChat(payload),
    id = `update:${payload.update_id}`;
  const status = await invocation(
    null,
    async () => {
      // Ignore unapproved messages before storing their text or entering the causal queue.
      if (
        chat === null ||
        (!(await isChatApproved(chat)) && !isOwnerInit(payload))
      )
        return "complete";
      await enqueue(id, "update", chat, payload);
      return (await raw("SELECT status FROM work_items WHERE id=$1", [id]))
        .rows[0].status;
    },
    signal,
  );
  if (status === "complete") return status;
  await drainChat(chat, createBot(), signal);
  return invocation(
    null,
    async () =>
      (await raw("SELECT status FROM work_items WHERE id=$1", [id])).rows[0]
        .status,
    signal,
  );
}
async function recoverSnapshots(bot: Bot) {
  const rows = (
    await raw<Item>(
      "SELECT * FROM work_items w WHERE kind='snapshot' AND status IN ('pending','failed') AND EXISTS (SELECT 1 FROM epic_links l JOIN responses r ON r.user_id=l.user_id AND NOT r.is_bot JOIN approved_chats a ON a.chat_id=r.chat_id WHERE l.epic_account_id=w.payload->>'account_id') ORDER BY updated_at,created_at,id LIMIT 20",
    )
  ).rows;
  for (const item of rows) {
    await advisoryLock(
      `snapshot:${item.payload.account_id}`,
      async () => {
        const latest = (
          await raw<Item>("SELECT * FROM work_items WHERE id=$1", [item.id])
        ).rows[0];
        if (latest && ["pending", "failed"].includes(latest.status))
          await executeItem(latest, bot);
      },
      false,
    );
  }
}
export async function recoverPending(bot: Bot) {
  const signal = current().signal;
  const rows = (
    await raw(
      "SELECT w.chat_id FROM work_items w WHERE kind NOT IN ('job','snapshot') AND status IN ('pending','failed') AND (EXISTS (SELECT 1 FROM approved_chats a WHERE a.chat_id=w.chat_id) OR (kind='update' AND w.payload->'message'->>'text' ~ '^/init(@[A-Za-z0-9_]+)?([[:space:]]|$)')) GROUP BY w.chat_id ORDER BY min(created_at) LIMIT 20",
    )
  ).rows;
  for (const row of rows) await drainChat(row.chat_id, bot, signal);
  await recoverSnapshots(bot);
}
