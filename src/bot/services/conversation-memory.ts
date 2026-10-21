import { query, raw, timestamp } from "../storage";
import { externalCheckpoint, valueCheckpoint } from "../work";
import { deleteMemoryScope } from "../memory";
import { extractFacts } from "./conversation-model";
import { rememberSource, type Source } from "./conversation-store";

export async function enqueueConversationMemory(now: number) {
  // At most five new jobs/tick, one batch/chat, all executed by the causal queue.
  const chats = (
    await raw(
      `SELECT a.chat_id FROM approved_chats a
    WHERE (EXISTS(SELECT 1 FROM conversation_messages m WHERE m.chat_id=a.chat_id
      AND NOT m.processed AND NOT m.forgotten AND NOT m.is_bot AND m.user_id>0 AND m.text NOT LIKE '/%' AND m.sent_at>=to_timestamp($1)-interval '30 days')
      OR EXISTS(SELECT 1 FROM conversation_memory_deletions d WHERE d.chat_id=a.chat_id AND NOT d.complete AND d.attempts<6 AND d.retry_at<=to_timestamp($1)))
    AND NOT EXISTS(SELECT 1 FROM conversation_state s WHERE s.chat_id=a.chat_id AND s.thread_id=0 AND s.extracted_at>to_timestamp($1)-interval '10 minutes')
    AND NOT EXISTS(SELECT 1 FROM work_items w WHERE w.chat_id=a.chat_id AND w.kind='conversation-memory' AND w.status<>'complete')
    ORDER BY a.chat_id LIMIT 5`,
      [now],
    )
  ).rows;
  for (const { chat_id: chat } of chats)
    await raw(
      `INSERT INTO work_items(id,kind,chat_id,payload,conversation_version) VALUES($1,'conversation-memory',$2,$3,2) ON CONFLICT DO NOTHING`,
      [
        `memory:${chat}:${Math.floor(now / 600)}`,
        chat,
        JSON.stringify({ now }),
      ],
    );
}
export async function extractConversationMemory(chat: number, now: number) {
  const sources = await query<Source & Record<string, unknown>>(
    `SELECT ('s:'||message_id) AS ref,message_id,user_id,name,text,
    EXTRACT(EPOCH FROM sent_at)::double precision AS ts,thread_id FROM conversation_messages
    WHERE chat_id=$1 AND NOT processed AND NOT forgotten AND NOT is_bot
      AND user_id>0 AND NOT forwarded AND text NOT LIKE '/%' AND sent_at>=to_timestamp($2)-interval '30 days'
    ORDER BY sent_at,message_id LIMIT 20`,
    [chat, now],
  );
  if (sources.length) {
    const facts = await externalCheckpoint("conversation-extract-v2", () =>
      extractFacts(sources, now),
    );
    // Provider outages must not block the chat's causal queue. Leave messages
    // unprocessed and retry in a fresh scheduled batch after the cooldown.
    for (const fact of facts ?? []) {
      const source = sources.find((s) => s.ref === fact.source_ref)!;
      await rememberSource(chat, source, fact.content, fact.expires_at, false);
    }
    if (facts !== null)
      await query(
        `UPDATE conversation_messages SET processed=true WHERE chat_id=$1 AND message_id=ANY($2::bigint[])`,
        [chat, sources.map((s) => s.message_id)],
      );
  }
  await query(
    `INSERT INTO conversation_state(chat_id,thread_id,extracted_at) VALUES($1,0,$2)
    ON CONFLICT(chat_id,thread_id) DO UPDATE SET extracted_at=excluded.extracted_at`,
    [chat, timestamp(now)],
  );
}
export async function retryMemoryDeletions(
  chat: number,
  now: number,
): Promise<boolean> {
  const deletions = await query(
    `SELECT user_id,epoch,attempts FROM conversation_memory_deletions
    WHERE chat_id=$1 AND NOT complete AND attempts<6 AND retry_at<=to_timestamp($2) ORDER BY user_id,epoch LIMIT 5`,
    [chat, now],
  );
  for (const deletion of deletions) {
    const complete = await externalCheckpoint(
      `conversation-delete-${deletion.user_id}-${deletion.epoch}-${deletion.attempts}`,
      () => deleteMemoryScope(chat, deletion.user_id, deletion.epoch),
    );
    const next = await valueCheckpoint(
      `conversation-delete-retry-${deletion.user_id}-${deletion.epoch}`,
      () => now + 600,
    );
    await query(
      `UPDATE conversation_memory_deletions SET complete=$4,attempts=attempts+1,retry_at=$5
      WHERE chat_id=$1 AND user_id=$2 AND epoch=$3`,
      [chat, deletion.user_id, deletion.epoch, complete, timestamp(next)],
    );
  }
  return !(
    await query(
      `SELECT 1 FROM conversation_memory_deletions WHERE chat_id=$1 AND NOT complete LIMIT 1`,
      [chat],
    )
  ).length;
}
