import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PROVIDER_COMMAND_PREFIX = "provider:herdr-codex:";
const MESSAGE_PROJECTOR = "projection.thread-messages";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Turn rows are keyed by thread and turn, so only their message reference needs repair.
  // Do this before rewriting the source event payloads used to identify the old value.
  yield* sql`
    UPDATE projection_turns
    SET assistant_message_id = (
      SELECT 'assistant:herdr-codex:'
        || source.stream_id
        || ':'
        || substr(source.command_id, ${PROVIDER_COMMAND_PREFIX.length + 1}, instr(
          substr(source.command_id, ${PROVIDER_COMMAND_PREFIX.length + 1}),
          ':'
        ) - 1)
        || ':'
        || substr(
          json_extract(source.payload_json, '$.messageId'),
          instr(json_extract(source.payload_json, '$.messageId'), ':') + 1
        )
      FROM orchestration_events AS source
      WHERE source.stream_id = projection_turns.thread_id
        AND source.event_type = 'thread.message-sent'
        AND source.command_id LIKE ${`${PROVIDER_COMMAND_PREFIX}%`}
        AND json_extract(source.payload_json, '$.turnId') = projection_turns.turn_id
        AND json_extract(source.payload_json, '$.messageId') = projection_turns.assistant_message_id
      ORDER BY source.sequence DESC
      LIMIT 1
    )
    WHERE assistant_message_id IS NOT NULL
      AND assistant_message_id NOT LIKE 'assistant:herdr-codex:%'
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS source
        WHERE source.stream_id = projection_turns.thread_id
          AND source.event_type = 'thread.message-sent'
          AND source.command_id LIKE ${`${PROVIDER_COMMAND_PREFIX}%`}
          AND json_extract(source.payload_json, '$.turnId') = projection_turns.turn_id
          AND json_extract(source.payload_json, '$.messageId') = projection_turns.assistant_message_id
      )
  `;

  yield* sql`
    UPDATE orchestration_events AS target
    SET payload_json = json_set(
      target.payload_json,
      '$.assistantMessageId',
      (
        SELECT 'assistant:herdr-codex:'
          || target.stream_id
          || ':'
          || substr(source.command_id, ${PROVIDER_COMMAND_PREFIX.length + 1}, instr(
            substr(source.command_id, ${PROVIDER_COMMAND_PREFIX.length + 1}),
            ':'
          ) - 1)
          || ':'
          || substr(
            json_extract(source.payload_json, '$.messageId'),
            instr(json_extract(source.payload_json, '$.messageId'), ':') + 1
          )
        FROM orchestration_events AS source
        WHERE source.stream_id = target.stream_id
          AND source.event_type = 'thread.message-sent'
          AND source.command_id LIKE ${`${PROVIDER_COMMAND_PREFIX}%`}
          AND json_extract(source.payload_json, '$.turnId') =
            json_extract(target.payload_json, '$.turnId')
          AND json_extract(source.payload_json, '$.messageId') =
            json_extract(target.payload_json, '$.assistantMessageId')
        ORDER BY source.sequence DESC
        LIMIT 1
      )
    )
    WHERE target.stream_id LIKE 'herdr-thread-%'
      AND target.event_type = 'thread.turn-diff-completed'
      AND json_extract(target.payload_json, '$.assistantMessageId') LIKE 'assistant:%'
      AND json_extract(target.payload_json, '$.assistantMessageId') NOT LIKE
        'assistant:herdr-codex:%'
      AND EXISTS (
        SELECT 1
        FROM orchestration_events AS source
        WHERE source.stream_id = target.stream_id
          AND source.event_type = 'thread.message-sent'
          AND source.command_id LIKE ${`${PROVIDER_COMMAND_PREFIX}%`}
          AND json_extract(source.payload_json, '$.turnId') =
            json_extract(target.payload_json, '$.turnId')
          AND json_extract(source.payload_json, '$.messageId') =
            json_extract(target.payload_json, '$.assistantMessageId')
      )
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.messageId',
      substr(json_extract(payload_json, '$.messageId'), 1, instr(
          json_extract(payload_json, '$.messageId'),
          ':'
        ))
        || 'herdr-codex:'
        || stream_id
        || ':'
        || substr(command_id, ${PROVIDER_COMMAND_PREFIX.length + 1}, instr(
          substr(command_id, ${PROVIDER_COMMAND_PREFIX.length + 1}),
          ':'
        ) - 1)
        || ':'
        || substr(
          json_extract(payload_json, '$.messageId'),
          instr(json_extract(payload_json, '$.messageId'), ':') + 1
        )
    )
    WHERE stream_id LIKE 'herdr-thread-%'
      AND event_type = 'thread.message-sent'
      AND command_id LIKE ${`${PROVIDER_COMMAND_PREFIX}%`}
      AND (
        json_extract(payload_json, '$.messageId') LIKE 'user:%'
        OR json_extract(payload_json, '$.messageId') LIKE 'assistant:%'
      )
      AND json_extract(payload_json, '$.messageId') NOT LIKE 'user:herdr-codex:%'
      AND json_extract(payload_json, '$.messageId') NOT LIKE 'assistant:herdr-codex:%'
  `;

  // Global legacy IDs may already have overwritten another thread's row. Replaying only
  // this projector reconstructs every message from the now-corrected source events.
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`
    UPDATE projection_state
    SET last_applied_sequence = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE projector = ${MESSAGE_PROJECTOR}
  `;
});
