/** Release requirements; CI checks this contract against the migrated schema. */
export const schemaContract = {
  sessions:
    "message_id chat_id initiator_id initiator_name is_complete is_expired is_closed style created_at completed_at time_slots tag_line llm_header fort_title",
  responses:
    "chat_id message_id user_id user_name response responded_at joined_at time_slot is_bot",
  chat_features: "chat_id feature enabled value",
  afk_mutes: "chat_id user_id muted_until",
  chat_fort_titles: "chat_id title",
  roast_state: "chat_id history_json roast_msgs_json last_roast",
  epic_links: "chat_id user_id user_name epic_name epic_account_id linked_at",
  squad_snapshots:
    "epic_account_id fetched_at matches wins kills deaths_est kd overall_matches overall_wins overall_kills overall_deaths_est overall_kd",
  fort_cooldowns: "chat_id user_id attempted_at",
  service_state: "key value",
  work_items:
    "id kind chat_id payload status created_at updated_at attempts error",
  work_steps: "work_id step signature status result",
  job_http_requests:
    "request_id job requested_at completed_at status_code timed_out error",
  statistics_cache:
    "cache_key version result fetched_at expires_at retry_after",
  roast_profiles:
    "chat_id preferences pending_question last_evaluated_at changed_by changed_message_id changed_at",
  approved_chats: "chat_id approved_by approved_at",
} as const;
