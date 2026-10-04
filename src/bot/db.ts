import { query, chatId, getSessions, timestamp } from "./storage";
import { valueCheckpoint } from "./work";
export { getSessions };
export interface Session {
  chat_id: number;
  message_id: number;
  initiator_id: number;
  initiator_name: string;
  go_players: Map<number, string>;
  pass_players: Map<number, string>;
  player_slots: Map<number, string>;
  tagged_users: Map<number, string>;
  is_complete: boolean;
  is_expired: boolean;
  is_closed: boolean;
  style: number;
  created_at: number;
  completed_at: number | null;
  time_slots: string[];
  llm_header: string | null;
  fort_title: string | null;
}
export function newSession(
  fields: Pick<
    Session,
    "chat_id" | "message_id" | "initiator_id" | "initiator_name"
  > &
    Partial<Session>,
): Session {
  return {
    go_players: new Map(),
    pass_players: new Map(),
    player_slots: new Map(),
    tagged_users: new Map(),
    is_complete: false,
    is_expired: false,
    is_closed: false,
    style: 0,
    created_at: Date.now() / 1000,
    completed_at: null,
    time_slots: [],
    llm_header: null,
    fort_title: null,
    ...fields,
  };
}
export interface ChatStats {
  total_sessions: number;
  completed_sessions: number;
  expired_sessions: number;
  active_sessions: number;
  top_players: [string, number][];
  top_initiators: [string, number][];
  top_passers: [string, number][];
  avg_fill_seconds: number | null;
  fastest_fill_seconds: number | null;
  top_streaks: [string, number][];
  best_hours: [number, number, number | null][];
}
export interface EpicLink {
  chat_id: number;
  user_id: number;
  user_name: string;
  epic_name: string;
  epic_account_id: string;
  linked_at: number;
}
export interface SquadSnapshot {
  epic_account_id: string;
  fetched_at: number;
  matches: number;
  wins: number;
  kills: number;
  deaths_est: number;
  kd: number;
  overall_matches: number | null;
  overall_wins: number | null;
  overall_kills: number | null;
  overall_deaths_est: number | null;
  overall_kd: number | null;
}
const now = (name: string) =>
  valueCheckpoint(
    name,
    () => (performance.timeOrigin + performance.now()) / 1000,
  );
export async function get_fort_title(chat: number): Promise<string | null> {
  return (
    (
      await query("SELECT title FROM chat_fort_titles WHERE chat_id=$1", [chat])
    )[0]?.title ?? null
  );
}
export async function set_fort_title(chat: number, title: string | null) {
  if (title === null)
    await query("DELETE FROM chat_fort_titles WHERE chat_id=$1", [chat]);
  else
    await query(
      "INSERT INTO chat_fort_titles(chat_id,title) VALUES ($1,$2) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title",
      [chat, title],
    );
}
export async function save_session(s: Session) {
  await query(
    `INSERT INTO sessions(message_id,chat_id,initiator_id,initiator_name,is_complete,is_expired,is_closed,style,created_at,completed_at,time_slots,tag_line,llm_header,fort_title)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(chat_id,message_id) DO UPDATE SET
    initiator_id=excluded.initiator_id,initiator_name=excluded.initiator_name,is_complete=excluded.is_complete,is_expired=excluded.is_expired,is_closed=excluded.is_closed,style=excluded.style,created_at=excluded.created_at,completed_at=excluded.completed_at,time_slots=excluded.time_slots,tag_line=excluded.tag_line,llm_header=excluded.llm_header,fort_title=excluded.fort_title`,
    [
      s.message_id,
      s.chat_id,
      s.initiator_id,
      s.initiator_name,
      s.is_complete,
      s.is_expired,
      s.is_closed,
      s.style,
      timestamp(s.created_at),
      timestamp(s.completed_at),
      JSON.stringify(s.time_slots),
      JSON.stringify(Object.fromEntries(s.tagged_users)),
      s.llm_header,
      s.fort_title,
    ],
  );
}
export async function save_response(
  mid: number,
  uid: number,
  name: string,
  response: "go" | "pass",
  options: {
    time_slot?: string | null;
    is_bot?: boolean;
    became_complete?: boolean;
    chat_id?: number;
  } = {},
) {
  const chat = chatId(options.chat_id);
  const time = await now("response.time");
  await query(
    `INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at,time_slot,is_bot,joined_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(chat_id,message_id,user_id) DO UPDATE SET user_name=excluded.user_name,response=excluded.response,responded_at=excluded.responded_at,time_slot=excluded.time_slot,is_bot=excluded.is_bot,
    joined_at=CASE WHEN excluded.response='pass' THEN NULL WHEN responses.response='go' THEN responses.joined_at ELSE excluded.joined_at END`,
    [
      chat,
      mid,
      uid,
      name,
      response,
      timestamp(time),
      options.time_slot ?? null,
      options.is_bot ?? false,
      response === "go" ? timestamp(time) : null,
    ],
  );
  if (options.became_complete)
    await query(
      "UPDATE sessions SET is_complete=true,completed_at=COALESCE(completed_at,$1) WHERE chat_id=$2 AND message_id=$3",
      [timestamp(time), chat, mid],
    );
}
export async function load_session(
  mid: number,
  chat?: number,
): Promise<Session | null> {
  const cid = chatId(chat);
  const row = (
    await query("SELECT * FROM sessions WHERE chat_id=$1 AND message_id=$2", [
      cid,
      mid,
    ])
  )[0];
  if (!row) return null;
  const session = newSession({
    chat_id: cid,
    message_id: mid,
    initiator_id: row.initiator_id,
    initiator_name: row.initiator_name,
    is_complete: row.is_complete,
    is_expired: row.is_expired,
    is_closed: row.is_closed,
    style: row.style,
    created_at: row.created_at,
    completed_at: row.completed_at,
    time_slots: row.time_slots ?? [],
    tagged_users: new Map(
      Object.entries(row.tag_line ?? {}).map(([k, v]) => [
        Number(k),
        String(v),
      ]),
    ),
    llm_header: row.llm_header,
    fort_title: row.fort_title,
  });
  for (const r of await query(
    "SELECT user_id,user_name,response,time_slot FROM responses WHERE chat_id=$1 AND message_id=$2 ORDER BY CASE WHEN joined_at IS NULL THEN 1 ELSE 0 END,joined_at,responded_at",
    [cid, mid],
  )) {
    if (r.response === "go") {
      session.go_players.set(r.user_id, r.user_name);
      if (r.time_slot) session.player_slots.set(r.user_id, r.time_slot);
    } else session.pass_players.set(r.user_id, r.user_name);
  }
  return session;
}
export async function mark_complete(mid: number, chat?: number) {
  await query(
    "UPDATE sessions SET is_complete=true,completed_at=COALESCE(completed_at,$1) WHERE chat_id=$2 AND message_id=$3",
    [timestamp(await now("session.completed")), chatId(chat), mid],
  );
}
export async function mark_expired(mid: number, chat?: number) {
  await query(
    "UPDATE sessions SET is_closed=true,is_expired=true WHERE chat_id=$1 AND message_id=$2",
    [chatId(chat), mid],
  );
}
export async function mark_closed(mid: number, chat?: number) {
  await query(
    "UPDATE sessions SET is_closed=true WHERE chat_id=$1 AND message_id=$2",
    [chatId(chat), mid],
  );
}
export async function load_active_sessions(chat?: number): Promise<Session[]> {
  const rows = await query(
    "SELECT chat_id,message_id FROM sessions WHERE is_closed=false" +
      (chat === undefined ? "" : " AND chat_id=$1"),
    chat === undefined ? [] : [chat],
  );
  const result: Session[] = [];
  for (const row of rows) {
    const s = await load_session(row.message_id, row.chat_id);
    if (s) result.push(s);
  }
  return result;
}
export async function get_chat_participants(
  chat: number,
): Promise<[number, string][]> {
  return (
    await query(
      `SELECT user_id,user_name FROM (SELECT DISTINCT ON(r.user_id) r.user_id,r.user_name,r.responded_at FROM responses r WHERE r.chat_id=$1 AND r.response='go' AND NOT r.is_bot
    AND NOT EXISTS(SELECT 1 FROM afk_mutes a WHERE a.chat_id=r.chat_id AND a.user_id=r.user_id AND a.muted_until>$2) ORDER BY r.user_id,r.responded_at DESC) recent ORDER BY responded_at DESC LIMIT 20`,
      [chat, timestamp(await now("participants.time"))],
    )
  ).map((r) => [r.user_id, r.user_name]);
}
export async function set_afk(chat: number, uid: number, until: number) {
  await query(
    "INSERT INTO afk_mutes(chat_id,user_id,muted_until) VALUES ($1,$2,$3) ON CONFLICT(chat_id,user_id) DO UPDATE SET muted_until=excluded.muted_until",
    [chat, uid, timestamp(until)],
  );
}
export async function clear_afk(chat: number, uid: number) {
  await query("DELETE FROM afk_mutes WHERE chat_id=$1 AND user_id=$2", [
    chat,
    uid,
  ]);
}
export async function get_afk_until(
  chat: number,
  uid: number,
): Promise<number | null> {
  return (
    (
      await query(
        "SELECT muted_until FROM afk_mutes WHERE chat_id=$1 AND user_id=$2",
        [chat, uid],
      )
    )[0]?.muted_until ?? null
  );
}
export async function get_active_chat_ids(days = 14): Promise<number[]> {
  return (
    await query(
      "SELECT DISTINCT s.chat_id FROM sessions s JOIN approved_chats a ON a.chat_id=s.chat_id WHERE s.created_at>$1",
      [timestamp((await now("active.chats.time")) - days * 86400)],
    )
  ).map((r) => r.chat_id);
}
export async function is_feature_enabled(
  chat: number,
  feature: string,
): Promise<boolean> {
  return (
    (
      await query(
        "SELECT enabled FROM chat_features WHERE chat_id=$1 AND feature=$2",
        [chat, feature],
      )
    )[0]?.enabled ?? false
  );
}
export async function set_feature(
  chat: number,
  feature: string,
  enabled: boolean,
  value: number | null = null,
) {
  await query(
    "INSERT INTO chat_features(chat_id,feature,enabled,value) VALUES ($1,$2,$3,$4) ON CONFLICT(chat_id,feature) DO UPDATE SET enabled=excluded.enabled,value=excluded.value",
    [chat, feature, enabled, value],
  );
}
export async function get_feature_value(
  chat: number,
  feature: string,
): Promise<number | null> {
  return (
    (
      await query(
        "SELECT value FROM chat_features WHERE chat_id=$1 AND feature=$2",
        [chat, feature],
      )
    )[0]?.value ?? null
  );
}
export async function get_last_weekly_drop(chat: number) {
  return get_feature_value(chat, "weekly_drop");
}
export async function set_last_weekly_drop(chat: number, time: number) {
  await set_feature(chat, "weekly_drop", true, time);
}
export async function get_fort_cooldown(
  chat: number,
  uid: number,
): Promise<number | null> {
  return (
    (
      await query(
        "SELECT attempted_at FROM fort_cooldowns WHERE chat_id=$1 AND user_id=$2",
        [chat, uid],
      )
    )[0]?.attempted_at ?? null
  );
}
export async function set_fort_cooldown(
  chat: number,
  uid: number,
  time: number,
) {
  await query(
    "INSERT INTO fort_cooldowns(chat_id,user_id,attempted_at) VALUES ($1,$2,$3) ON CONFLICT(chat_id,user_id) DO UPDATE SET attempted_at=excluded.attempted_at",
    [chat, uid, timestamp(time)],
  );
}
export async function save_roast_state(
  chat: number,
  history: unknown[],
  messages: number[],
  last: number | null,
) {
  await query(
    "INSERT INTO roast_state(chat_id,history_json,roast_msgs_json,last_roast) VALUES ($1,$2,$3,$4) ON CONFLICT(chat_id) DO UPDATE SET history_json=excluded.history_json,roast_msgs_json=excluded.roast_msgs_json,last_roast=excluded.last_roast",
    [chat, JSON.stringify(history), JSON.stringify(messages), timestamp(last)],
  );
}
export async function load_all_roast_state(
  chat?: number,
): Promise<[number, unknown[], number[], number | null][]> {
  return (
    await query(
      "SELECT chat_id,history_json,roast_msgs_json,last_roast FROM roast_state" +
        (chat === undefined ? "" : " WHERE chat_id=$1"),
      chat === undefined ? [] : [chat],
    )
  ).map((r) => [
    r.chat_id,
    r.history_json ?? [],
    r.roast_msgs_json ?? [],
    r.last_roast,
  ]);
}
export async function save_epic_link(
  chat: number,
  uid: number,
  name: string,
  epic: string,
  account: string,
) {
  await query(
    "INSERT INTO epic_links(chat_id,user_id,user_name,epic_name,epic_account_id,linked_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(chat_id,user_id) DO UPDATE SET user_name=excluded.user_name,epic_name=excluded.epic_name,epic_account_id=excluded.epic_account_id,linked_at=excluded.linked_at",
    [chat, uid, name, epic, account, timestamp(await now("epic.link.time"))],
  );
}
export async function get_epic_link(
  chat: number,
  uid: number,
): Promise<EpicLink | null> {
  return (
    (
      await query<EpicLink>(
        "SELECT * FROM epic_links WHERE chat_id=$1 AND user_id=$2",
        [chat, uid],
      )
    )[0] ?? null
  );
}
export async function get_chat_epic_links(chat: number): Promise<EpicLink[]> {
  return query<EpicLink>(
    "SELECT * FROM epic_links WHERE chat_id=$1 ORDER BY linked_at",
    [chat],
  );
}
export async function get_chats_with_epic_links(): Promise<number[]> {
  return (
    await query(
      "SELECT DISTINCT l.chat_id FROM epic_links l JOIN approved_chats a ON a.chat_id=l.chat_id",
    )
  ).map((r) => r.chat_id);
}
export async function resolve_user_by_username(
  chat: number,
  name: string,
): Promise<[number, string] | null> {
  const r = (
    await query(
      `SELECT r.user_id,r.user_name FROM responses r JOIN sessions s ON r.chat_id=s.chat_id AND r.message_id=s.message_id WHERE s.chat_id=$1 AND LOWER(r.user_name)=LOWER($2) AND r.is_bot=false ORDER BY r.responded_at DESC LIMIT 1`,
      [chat, name],
    )
  )[0];
  return r ? [r.user_id, r.user_name] : null;
}
export async function save_squad_snapshot(
  account: string,
  time: number,
  matches: number,
  wins: number,
  kills: number,
  deaths: number,
  kd: number,
  overall_matches: number | null = null,
  overall_wins: number | null = null,
  overall_kills: number | null = null,
  overall_deaths_est: number | null = null,
  overall_kd: number | null = null,
) {
  await query(
    `INSERT INTO squad_snapshots(epic_account_id,fetched_at,matches,wins,kills,deaths_est,kd,overall_matches,overall_wins,overall_kills,overall_deaths_est,overall_kd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(epic_account_id,fetched_at) DO UPDATE SET matches=excluded.matches,wins=excluded.wins,kills=excluded.kills,deaths_est=excluded.deaths_est,kd=excluded.kd,overall_matches=excluded.overall_matches,overall_wins=excluded.overall_wins,overall_kills=excluded.overall_kills,overall_deaths_est=excluded.overall_deaths_est,overall_kd=excluded.overall_kd`,
    [
      account,
      timestamp(time),
      matches,
      wins,
      kills,
      deaths,
      kd,
      overall_matches,
      overall_wins,
      overall_kills,
      overall_deaths_est,
      overall_kd,
    ],
  );
}
export async function get_snapshot_before(
  account: string,
  cutoff: number,
  floor?: number,
): Promise<SquadSnapshot | null> {
  return (
    (
      await query<SquadSnapshot>(
        "SELECT * FROM squad_snapshots WHERE epic_account_id=$1 AND fetched_at<=$2" +
          (floor === undefined ? "" : " AND fetched_at>=$3") +
          " ORDER BY fetched_at DESC LIMIT 1",
        floor === undefined
          ? [account, timestamp(cutoff)]
          : [account, timestamp(cutoff), timestamp(floor)],
      )
    )[0] ?? null
  );
}
export async function cleanup_old_snapshots(days = 30): Promise<number> {
  return (
    await query(
      "DELETE FROM squad_snapshots WHERE fetched_at<$1 RETURNING epic_account_id",
      [timestamp((await now("snapshot.cleanup.time")) - days * 86400)],
    )
  ).length;
}
export async function get_chat_stats(chat: number): Promise<ChatStats> {
  const result: ChatStats = {
    total_sessions: 0,
    completed_sessions: 0,
    expired_sessions: 0,
    active_sessions: 0,
    top_players: [],
    top_initiators: [],
    top_passers: [],
    avg_fill_seconds: null,
    fastest_fill_seconds: null,
    top_streaks: [],
    best_hours: [],
  };
  const counts = (
    await query(
      `SELECT COUNT(*) AS total_sessions,COUNT(*) FILTER(WHERE is_complete AND NOT is_expired) AS completed_sessions,COUNT(*) FILTER(WHERE is_closed AND is_expired) AS expired_sessions,COUNT(*) FILTER(WHERE NOT is_closed) AS active_sessions FROM sessions WHERE chat_id=$1`,
      [chat],
    )
  )[0];
  Object.assign(result, counts);
  for (const [response, key, limit] of [
    ["go", "top_players", 10],
    ["pass", "top_passers", 5],
  ] as const) {
    result[key] = (
      await query(
        `SELECT (array_agg(r.user_name ORDER BY r.responded_at DESC))[1] AS name,COUNT(*) AS count FROM responses r JOIN sessions s ON r.chat_id=s.chat_id AND r.message_id=s.message_id WHERE s.chat_id=$1 AND r.response=$2 GROUP BY r.user_id ORDER BY count DESC LIMIT $3`,
        [chat, response, limit],
      )
    ).map((r) => [r.name, r.count]);
  }
  result.top_initiators = (
    await query(
      "SELECT (array_agg(initiator_name ORDER BY created_at DESC))[1] AS name,COUNT(*) AS count FROM sessions WHERE chat_id=$1 GROUP BY initiator_id ORDER BY count DESC LIMIT 5",
      [chat],
    )
  ).map((r) => [r.name, r.count]);
  const times = (
    await query(
      `SELECT AVG(EXTRACT(EPOCH FROM completed_at-created_at)) AS avg,MIN(EXTRACT(EPOCH FROM completed_at-created_at)) AS min FROM sessions WHERE chat_id=$1 AND is_complete AND NOT is_expired AND completed_at IS NOT NULL`,
      [chat],
    )
  )[0];
  result.avg_fill_seconds = times.avg;
  result.fastest_fill_seconds = times.min;
  const completed = (
    await query(
      "SELECT message_id FROM sessions WHERE chat_id=$1 AND is_complete AND NOT is_expired ORDER BY created_at DESC",
      [chat],
    )
  ).map((r) => r.message_id as number);
  if (completed.length) {
    const rows = await query(
      "SELECT message_id,user_id,user_name FROM responses WHERE chat_id=$1 AND message_id=ANY($2::bigint[]) AND response=$3",
      [chat, completed, "go"],
    );
    const by = new Map(completed.map((mid) => [mid, new Set<number>()]));
    const names = new Map<number, string>();
    for (const r of rows) {
      by.get(r.message_id)!.add(r.user_id);
      names.set(r.user_id, r.user_name);
    }
    let active = new Map([...by.get(completed[0])!].map((uid) => [uid, 1]));
    for (const mid of completed.slice(1)) {
      active = new Map(
        [...active]
          .filter(([uid]) => by.get(mid)!.has(uid))
          .map(([uid, n]) => [uid, n + 1]),
      );
      if (!active.size) break;
    }
    result.top_streaks = [...active]
      .map(([uid, n]): [string, number] => [names.get(uid)!, n])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }
  result.best_hours = (
    await query(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Europe/Moscow')::integer AS hour,COUNT(*) AS count,AVG(EXTRACT(EPOCH FROM completed_at-created_at)) AS avg FROM sessions WHERE chat_id=$1 AND is_complete AND NOT is_expired AND completed_at IS NOT NULL GROUP BY hour ORDER BY count DESC,avg ASC LIMIT 2`,
      [chat],
    )
  ).map((r) => [r.hour, r.count, r.avg]);
  return result;
}
