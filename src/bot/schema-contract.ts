/** Release requirements; CI checks this contract against the migrated schema. */
export const schemaContract = {
  sessions:
    "message_id chat_id initiator_id initiator_name is_complete is_expired is_closed style created_at completed_at time_slots tag_line llm_header fort_title gathering",
  responses:
    "chat_id message_id user_id user_name response responded_at joined_at time_slot is_bot available_at ready_at",
  chat_features: "chat_id feature enabled value",
  afk_mutes: "chat_id user_id muted_until",
  chat_fort_titles: "chat_id title",
  roast_state: "chat_id history_json roast_msgs_json last_roast",
  epic_links: "user_id user_name epic_name epic_account_id linked_at",
  squad_snapshots:
    "epic_account_id fetched_at matches wins kills deaths_est kd overall_matches overall_wins overall_kills overall_deaths_est overall_kd",
  fort_cooldowns: "chat_id user_id attempted_at",
  service_state: "key value",
  work_items:
    "id kind chat_id payload status created_at updated_at attempts error conversation_version",
  work_steps: "work_id step signature status result",
  job_http_requests:
    "request_id job requested_at completed_at status_code timed_out error",
  statistics_cache:
    "cache_key version result fetched_at expires_at retry_after",
  roast_profiles:
    "chat_id preferences pending_question last_evaluated_at changed_by changed_message_id changed_at",
  conversation_messages:
    "chat_id message_id user_id name text sent_at edited_at thread_id reply_to_id is_bot forwarded citation_refs processed forgotten search_vector",
  conversation_memories:
    "id chat_id source_message_id user_id name thread_id content quote source_at expires_at created_at explicit search_vector",
  conversation_state:
    "chat_id thread_id dialogue_user_id dialogue_until pending_user_id pending_question evaluated_at proactive_at reacted_at extracted_at",
  conversation_memory_epochs: "chat_id user_id epoch",
  conversation_memory_deletions:
    "chat_id user_id epoch attempts retry_at complete",
  approved_chats: "chat_id approved_by approved_at",
} as const;
