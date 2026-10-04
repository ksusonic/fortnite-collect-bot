import { query, timestamp } from "../storage";
import { parsePreferences, type RoastPreferences } from "./roast-policy";

export interface RoastProfile {
  preferences: Partial<RoastPreferences>;
  pending_question: string | null;
  last_evaluated_at: number | null;
}
export async function loadRoastProfile(chat: number): Promise<RoastProfile> {
  const row = (
    await query(
      `SELECT p.preferences,p.pending_question,p.last_evaluated_at,f.enabled AS legacy_enabled
     FROM (SELECT $1::bigint AS chat_id) c
     LEFT JOIN roast_profiles p ON p.chat_id=c.chat_id
     LEFT JOIN chat_features f ON f.chat_id=c.chat_id AND f.feature='roast'`,
      [chat],
    )
  )[0]!;
  return {
    // Also handles a historical SQLite import performed after this migration.
    preferences:
      parsePreferences(row.preferences) ??
      (typeof row.legacy_enabled === "boolean"
        ? { proactive: row.legacy_enabled }
        : {}),
    pending_question: row.pending_question ?? null,
    last_evaluated_at: row.last_evaluated_at ?? null,
  };
}
export async function saveRoastProfile(
  chat: number,
  profile: RoastProfile,
  source?: { user: number; message: number; now: number },
) {
  await query(
    `INSERT INTO roast_profiles(chat_id,preferences,pending_question,last_evaluated_at,changed_by,changed_message_id,changed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(chat_id) DO UPDATE SET preferences=excluded.preferences,pending_question=excluded.pending_question,
       last_evaluated_at=excluded.last_evaluated_at,
       changed_by=COALESCE(excluded.changed_by,roast_profiles.changed_by),
       changed_message_id=COALESCE(excluded.changed_message_id,roast_profiles.changed_message_id),
       changed_at=COALESCE(excluded.changed_at,roast_profiles.changed_at)`,
    [
      chat,
      JSON.stringify(profile.preferences),
      profile.pending_question,
      timestamp(profile.last_evaluated_at),
      source?.user ?? null,
      source?.message ?? null,
      timestamp(source?.now),
    ],
  );
}
