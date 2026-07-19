import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const RUNTIME_ITEM_PREFIX = "herdr-codex:";
const ASSISTANT_MESSAGE_PREFIX = `assistant:${RUNTIME_ITEM_PREFIX}`;
const MESSAGE_PROJECTOR = "projection.thread-messages";
const ACTIVITY_PROJECTOR = "projection.thread-activities";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [legacyRow] = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count
    FROM orchestration_events
    WHERE stream_id LIKE 'herdr-thread-%'
      AND (
        (
          event_type = 'thread.message-sent'
          AND (
            (
              json_extract(payload_json, '$.messageId') LIKE 'user:herdr-codex:%'
              AND json_extract(payload_json, '$.messageId') NOT LIKE
                'user:herdr-codex:' || stream_id || ':%'
            )
            OR (
              json_extract(payload_json, '$.messageId') LIKE 'assistant:herdr-codex:%'
              AND json_extract(payload_json, '$.messageId') NOT LIKE
                'assistant:herdr-codex:' || stream_id || ':%'
            )
          )
        )
        OR (
          event_type = 'thread.activity-appended'
          AND command_id LIKE 'provider:herdr-codex:%'
          AND json_extract(payload_json, '$.activity.id') LIKE 'herdr-codex:%'
          AND json_extract(payload_json, '$.activity.id') NOT LIKE
            'herdr-codex:' || stream_id || ':%'
        )
      )
  `;
  if ((legacyRow?.count ?? 0) === 0) {
    return;
  }

  yield* sql`
    UPDATE projection_turns
    SET assistant_message_id = ${ASSISTANT_MESSAGE_PREFIX}
      || thread_id
      || ':'
      || substr(assistant_message_id, ${ASSISTANT_MESSAGE_PREFIX.length + 1})
    WHERE thread_id LIKE 'herdr-thread-%'
      AND assistant_message_id LIKE ${`${ASSISTANT_MESSAGE_PREFIX}%`}
      AND assistant_message_id NOT LIKE ${ASSISTANT_MESSAGE_PREFIX} || thread_id || ':%'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.assistantMessageId',
      ${ASSISTANT_MESSAGE_PREFIX}
        || stream_id
        || ':'
        || substr(
          json_extract(payload_json, '$.assistantMessageId'),
          ${ASSISTANT_MESSAGE_PREFIX.length + 1}
        )
    )
    WHERE stream_id LIKE 'herdr-thread-%'
      AND event_type = 'thread.turn-diff-completed'
      AND json_extract(payload_json, '$.assistantMessageId') LIKE
        ${`${ASSISTANT_MESSAGE_PREFIX}%`}
      AND json_extract(payload_json, '$.assistantMessageId') NOT LIKE
        ${ASSISTANT_MESSAGE_PREFIX} || stream_id || ':%'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.messageId',
      substr(
        json_extract(payload_json, '$.messageId'),
        1,
        instr(json_extract(payload_json, '$.messageId'), ${RUNTIME_ITEM_PREFIX})
          + ${RUNTIME_ITEM_PREFIX.length - 1}
      )
        || stream_id
        || ':'
        || substr(
          json_extract(payload_json, '$.messageId'),
          instr(json_extract(payload_json, '$.messageId'), ${RUNTIME_ITEM_PREFIX})
            + ${RUNTIME_ITEM_PREFIX.length}
        )
    )
    WHERE stream_id LIKE 'herdr-thread-%'
      AND event_type = 'thread.message-sent'
      AND (
        json_extract(payload_json, '$.messageId') LIKE 'user:herdr-codex:%'
        OR json_extract(payload_json, '$.messageId') LIKE 'assistant:herdr-codex:%'
      )
      AND json_extract(payload_json, '$.messageId') NOT LIKE
        'user:herdr-codex:' || stream_id || ':%'
      AND json_extract(payload_json, '$.messageId') NOT LIKE
        'assistant:herdr-codex:' || stream_id || ':%'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(
      payload_json,
      '$.activity.id',
      ${RUNTIME_ITEM_PREFIX}
        || stream_id
        || ':'
        || substr(
          json_extract(payload_json, '$.activity.id'),
          ${RUNTIME_ITEM_PREFIX.length + 1}
        )
    )
    WHERE stream_id LIKE 'herdr-thread-%'
      AND event_type = 'thread.activity-appended'
      AND command_id LIKE 'provider:herdr-codex:%'
      AND json_extract(payload_json, '$.activity.id') LIKE 'herdr-codex:%'
      AND json_extract(payload_json, '$.activity.id') NOT LIKE
        'herdr-codex:' || stream_id || ':%'
  `;

  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_thread_activities`;
  yield* sql`
    UPDATE projection_state
    SET last_applied_sequence = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE projector = ${MESSAGE_PROJECTOR}
  `;
  yield* sql`
    UPDATE projection_state
    SET last_applied_sequence = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE projector = ${ACTIVITY_PROJECTOR}
  `;
});
