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
      `SELECT preferences,pending_question,last_evaluated_at FROM roast_profiles WHERE chat_id=$1`,
      [chat],
    )
  )[0];
  return {
    preferences: parsePreferences(row?.preferences) ?? {},
    pending_question: row?.pending_question ?? null,
    last_evaluated_at: row?.last_evaluated_at ?? null,
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
