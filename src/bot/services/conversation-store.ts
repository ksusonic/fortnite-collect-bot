import type { Message } from "grammy/types";
import { rememberMessage } from "../roast";
import type { Context } from "grammy";
import { query, timestamp, maybeCurrent } from "../storage";
import { isGeneralAdmin } from "./chat-access";

export interface Source {
  ref: string;
  message_id: number;
  user_id: number;
  name: string;
  text: string;
  ts: number;
  thread_id: number;
  expires_at?: number | null;
  quote?: string;
  forwarded?: boolean;
}
export interface ConversationState {
  dialogue_user_id?: number | null;
  dialogue_until?: number | null;
  pending_user_id?: number | null;
  pending_question?: string | null;
  evaluated_at?: number | null;
  proactive_at?: number | null;
  reacted_at?: number | null;
}
export function usesConversation(): boolean {
  return maybeCurrent()?.work?.conversationVersion === 2;
}
export async function archiveMessage(ctx: Context): Promise<void> {
  const message = ctx.message ?? ctx.editedMessage;
  if (!message || !ctx.chat) return;
  if (message.reply_to_message?.chat.id === ctx.chat.id)
    await archiveReceivedMessage(ctx.chat.id, message.reply_to_message);
  await archiveReceivedMessage(ctx.chat.id, message);
}
async function archiveReceivedMessage(
  chat: number,
  message: Message,
): Promise<void> {
  const text = message.text ?? message.caption;
  if (!text || !message.from || message.sender_chat) return;
  await query(
    `INSERT INTO conversation_messages(chat_id,message_id,user_id,name,text,sent_at,edited_at,thread_id,reply_to_id,is_bot,processed,forwarded)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(chat_id,message_id) DO UPDATE SET text=CASE WHEN conversation_messages.forgotten THEN '' ELSE excluded.text END,
     name=excluded.name,edited_at=excluded.edited_at,
     processed=CASE WHEN conversation_messages.forgotten THEN true WHEN conversation_messages.text=excluded.text THEN conversation_messages.processed ELSE excluded.processed END
     WHERE COALESCE(excluded.edited_at,excluded.sent_at)>=COALESCE(conversation_messages.edited_at,conversation_messages.sent_at)`,
    [
      chat,
      message.message_id,
      message.from.id,
      [message.from.first_name, message.from.last_name]
        .filter(Boolean)
        .join(" ") +
        (message.from.username ? ` (@${message.from.username})` : ""),
      text,
      timestamp(message.date),
      timestamp(message.edit_date),
      message.message_thread_id ?? 0,
      message.reply_to_message?.message_id ?? null,
      message.from.is_bot,
      message.from.is_bot || text.startsWith("/") || !!message.forward_origin,
      !!message.forward_origin,
    ],
  );
  if (!message.edit_date && !message.from.is_bot && !text.startsWith("/")) {
    rememberMessage(
      chat,
      message.from.first_name,
      text,
      message.date,
      message.message_id,
      message.reply_to_message?.message_id,
    );
  }
  if (message.edit_date) {
    // A changed source invalidates extracted claims; it will be evaluated again.
    await query(
      `DELETE FROM conversation_memories f USING conversation_messages m WHERE f.chat_id=$1 AND f.source_message_id=$2
         AND m.chat_id=f.chat_id AND m.message_id=f.source_message_id AND f.quote<>left(m.text,1000)`,
      [chat, message.message_id],
    );
  }
}
export async function stateFor(
  chat: number,
  thread: number,
): Promise<ConversationState> {
  return (
    (
      await query(
        `SELECT dialogue_user_id,EXTRACT(EPOCH FROM dialogue_until)::double precision AS dialogue_until,
    pending_user_id,pending_question,EXTRACT(EPOCH FROM (SELECT max(evaluated_at) FROM conversation_state g WHERE g.chat_id=$1))::double precision AS evaluated_at,
    EXTRACT(EPOCH FROM (SELECT max(proactive_at) FROM conversation_state g WHERE g.chat_id=$1))::double precision AS proactive_at,
    EXTRACT(EPOCH FROM (SELECT max(reacted_at) FROM conversation_state g WHERE g.chat_id=$1))::double precision AS reacted_at
    FROM (SELECT $1::bigint AS chat_id,$2::bigint AS thread_id) target LEFT JOIN conversation_state USING(chat_id,thread_id)`,
        [chat, thread],
      )
    )[0] ?? {}
  );
}
export async function evaluateAt(chat: number, thread: number, now: number) {
  await query(
    `INSERT INTO conversation_state(chat_id,thread_id,evaluated_at) VALUES($1,$2,$3)
    ON CONFLICT(chat_id,thread_id) DO UPDATE SET evaluated_at=excluded.evaluated_at`,
    [chat, thread, timestamp(now)],
  );
}
export async function saveDialogue(
  chat: number,
  thread: number,
  user: number,
  now: number,
  proactive: boolean,
  question: string | null,
) {
  await query(
    `INSERT INTO conversation_state(chat_id,thread_id,dialogue_user_id,dialogue_until,pending_user_id,pending_question,proactive_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chat_id,thread_id) DO UPDATE SET
    dialogue_user_id=excluded.dialogue_user_id,dialogue_until=excluded.dialogue_until,
    pending_user_id=excluded.pending_user_id,pending_question=excluded.pending_question,
    proactive_at=COALESCE(excluded.proactive_at,conversation_state.proactive_at)`,
    [
      chat,
      thread,
      user,
      timestamp(now + 300),
      question ? user : null,
      question,
      proactive ? timestamp(now) : null,
    ],
  );
}
const messageColumns = `('s:'||message_id) AS ref,message_id,user_id,name,text,
  EXTRACT(EPOCH FROM sent_at)::double precision AS ts,thread_id,NULL::text AS quote,forwarded`;
const memoryColumns = `('m:'||id) AS ref,source_message_id AS message_id,user_id,name,content AS text,
  EXTRACT(EPOCH FROM source_at)::double precision AS ts,thread_id,quote,false AS forwarded,
  EXTRACT(EPOCH FROM expires_at)::double precision AS expires_at`;
export async function recentSources(
  chat: number,
  thread: number,
  now: number,
): Promise<Source[]> {
  return (
    await query<Source & Record<string, unknown>>(
      `SELECT ${messageColumns} FROM conversation_messages
    WHERE chat_id=$1 AND thread_id=$2 AND NOT forgotten AND sent_at>=to_timestamp($3)-interval '30 days'
    ORDER BY sent_at DESC,message_id DESC LIMIT 30`,
      [chat, thread, now],
    )
  ).reverse();
}
export interface SearchSpec {
  queries: string[];
  user_id?: number;
  author?: string;
  after?: number;
  before?: number;
}
export async function searchSources(
  chat: number,
  thread: number,
  now: number,
  spec: SearchSpec,
): Promise<Source[]> {
  const args = [
    chat,
    thread,
    now,
    spec.queries.join(" OR ").slice(0, 1000),
    spec.user_id ?? null,
    timestamp(spec.after),
    timestamp(spec.before),
    spec.author ?? null,
  ];
  return query<Source & Record<string, unknown>>(
    `WITH candidates AS (
    SELECT ${messageColumns},NULL::double precision AS expires_at,
      ts_rank(search_vector,websearch_to_tsquery('russian',$4)||websearch_to_tsquery('simple',$4)) AS rank
    FROM conversation_messages WHERE chat_id=$1 AND thread_id=$2 AND NOT forgotten AND NOT is_bot
      AND sent_at>=to_timestamp($3)-interval '30 days' AND ($5::bigint IS NULL OR user_id=$5)
      AND ($8::text IS NULL OR position(lower($8) in lower(name))>0)
      AND ($6::timestamptz IS NULL OR sent_at>=$6) AND ($7::timestamptz IS NULL OR sent_at<=$7)
      AND ($4='' OR search_vector @@ (websearch_to_tsquery('russian',$4)||websearch_to_tsquery('simple',$4)))
    UNION ALL
    SELECT ${memoryColumns},ts_rank(search_vector,websearch_to_tsquery('russian',$4)||websearch_to_tsquery('simple',$4)) AS rank
    FROM conversation_memories WHERE chat_id=$1 AND thread_id=$2
      AND (expires_at IS NULL OR expires_at>to_timestamp($3)) AND ($5::bigint IS NULL OR user_id=$5)
      AND ($8::text IS NULL OR position(lower($8) in lower(name))>0)
      AND ($6::timestamptz IS NULL OR source_at>=$6) AND ($7::timestamptz IS NULL OR source_at<=$7)
      AND ($4='' OR search_vector @@ (websearch_to_tsquery('russian',$4)||websearch_to_tsquery('simple',$4)))
    ) SELECT * FROM candidates ORDER BY rank DESC,ts DESC,ref LIMIT 20`,
    args,
  );
}
export async function sourceByRef(
  chat: number,
  thread: number,
  ref: string,
  now: number,
  receivedReply = false,
): Promise<Source | undefined> {
  if (!/^[sm]:\d+$/.test(ref)) return;
  const memory = ref.startsWith("m:");
  return (
    await query<Source & Record<string, unknown>>(
      `SELECT ${memory ? memoryColumns : messageColumns}
    FROM ${memory ? "conversation_memories" : "conversation_messages"} WHERE chat_id=$1 AND thread_id=$2
    AND ${memory ? "id=$3 AND (expires_at IS NULL OR expires_at>to_timestamp($4))" : "message_id=$3 AND NOT forgotten AND ($5::boolean OR sent_at>=to_timestamp($4)-interval '30 days')"}`,
      memory
        ? [chat, thread, Number(ref.slice(2)), now]
        : [chat, thread, Number(ref.slice(2)), now, receivedReply],
    )
  )[0];
}
export async function rememberSource(
  chat: number,
  source: Source,
  content: string,
  expires: number | null,
  explicit: boolean,
) {
  if (
    !source.user_id ||
    source.forwarded ||
    !content.trim() ||
    content.length > 1000
  )
    return;
  await query(
    `INSERT INTO conversation_memories(chat_id,source_message_id,user_id,name,thread_id,content,quote,source_at,expires_at,explicit)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(chat_id,source_message_id,content) DO NOTHING`,
    [
      chat,
      source.message_id,
      source.user_id,
      source.name,
      source.thread_id,
      content,
      (source.quote ?? source.text).slice(0, 1000),
      timestamp(source.ts),
      timestamp(expires),
      explicit,
    ],
  );
}
export async function memoryEpoch(chat: number, user: number): Promise<number> {
  return (
    (
      await query(
        `SELECT epoch FROM conversation_memory_epochs WHERE chat_id=$1 AND user_id=$2`,
        [chat, user],
      )
    )[0]?.epoch ?? 0
  );
}
export async function forgetSource(
  chat: number,
  source: Source,
  requester: number,
  requestMessage?: number,
): Promise<boolean> {
  if (
    !source.user_id ||
    (source.user_id !== requester && !isGeneralAdmin(requester))
  )
    return false;
  // One atomic SQL checkpoint removes all derivations, redacts the source, invalidates
  // provider reads and schedules deletion of the old namespace. Retain the tombstone.
  await query(
    `WITH epoch AS (
    INSERT INTO conversation_memory_epochs(chat_id,user_id,epoch) VALUES($1,$2,1)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET epoch=conversation_memory_epochs.epoch+1 RETURNING epoch
  ), deletion AS (
    INSERT INTO conversation_memory_deletions(chat_id,user_id,epoch,retry_at)
    SELECT $1,$2,epoch-1,'-infinity'::timestamptz FROM epoch ON CONFLICT DO NOTHING
  ), facts AS (DELETE FROM conversation_memories WHERE chat_id=$1 AND source_message_id=$3),
  redacted AS (UPDATE conversation_messages SET text='',citation_refs='{}',forgotten=true,processed=true WHERE chat_id=$1 AND message_id<>$3 AND (message_id=$7 OR is_bot)),
  tombstone AS (INSERT INTO conversation_messages(chat_id,message_id,user_id,name,text,sent_at,thread_id,forgotten,processed)
    VALUES($1,$3,$2,$4,'',$5,$6,true,true)
    ON CONFLICT(chat_id,message_id) DO UPDATE SET text='',citation_refs='{}',forgotten=true,processed=true),
  history AS (UPDATE roast_state SET history_json='[]'::jsonb WHERE chat_id=$1)
  UPDATE conversation_state SET pending_question=NULL,pending_user_id=NULL,dialogue_until=NULL WHERE chat_id=$1`,
    [
      chat,
      source.user_id,
      source.message_id,
      source.name,
      timestamp(source.ts),
      source.thread_id,
      requestMessage ?? null,
    ],
  );
  return true;
}
export async function cleanupConversations() {
  // Keep redacted tombstones so replay/edits cannot reintroduce forgotten sources.
  await query(
    `DELETE FROM conversation_messages WHERE NOT forgotten AND sent_at<now()-interval '30 days'`,
  );
  await query(`DELETE FROM conversation_memories WHERE expires_at<=now()`);
}

/** Resolve citations of the last bot answer, including answers about older posts. */
export async function previousCitations(
  chat: number,
  thread: number,
  now: number,
  replyTo?: number,
): Promise<Source[]> {
  const refs = (
    await query(
      `SELECT citation_refs FROM conversation_messages WHERE chat_id=$1 AND thread_id=$2
    AND is_bot AND NOT forgotten AND sent_at>=to_timestamp($3)-interval '30 days'
    AND ($4::bigint IS NULL OR message_id=$4) ORDER BY sent_at DESC,message_id DESC LIMIT 1`,
      [chat, thread, now, replyTo ?? null],
    )
  )[0]?.citation_refs as string[] | undefined;
  const sources: Source[] = [];
  for (const ref of refs?.slice(0, 5) ?? []) {
    const source = await sourceByRef(chat, thread, ref, now);
    if (source) sources.push(source);
  }
  return sources;
}
