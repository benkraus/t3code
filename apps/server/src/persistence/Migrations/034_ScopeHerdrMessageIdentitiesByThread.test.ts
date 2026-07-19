import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_ScopeHerdrMessageIdentitiesByThread", (it) => {
  it.effect("upgrades session-scoped HerdR identities from migration 32", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 32 });

      for (const [sequence, threadId] of [
        [1, "herdr-thread-one"],
        [2, "herdr-thread-two"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_events (
            sequence,
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            actor_kind,
            payload_json,
            metadata_json
          ) VALUES (
            ${sequence},
            ${`event-${sequence}`},
            'thread',
            ${threadId},
            ${sequence},
            'thread.message-sent',
            '2026-07-19T00:00:00.000Z',
            ${`provider:herdr-codex:codex-session-one:turn-one:item:user-item-1:user-message-import:command-${sequence}`},
            'provider',
            json_object(
              'threadId',
              ${threadId},
              'messageId',
              'user:herdr-codex:codex-session-one:user-item-1',
              'role',
              'user',
              'text',
              ${threadId},
              'turnId',
              'turn-one',
              'streaming',
              json('false'),
              'createdAt',
              '2026-07-19T00:00:00.000Z',
              'updatedAt',
              '2026-07-19T00:00:00.000Z'
            ),
            '{}'
          )
        `;
      }

      yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          3,
          'event-assistant',
          'thread',
          'herdr-thread-one',
          3,
          'thread.message-sent',
          '2026-07-19T00:00:00.000Z',
          'provider:herdr-codex:codex-session-one:turn-one:item:assistant-item-1:assistant-complete:command-3',
          'provider',
          json_object(
            'threadId',
            'herdr-thread-one',
            'messageId',
            'assistant:herdr-codex:codex-session-one:assistant-item-1',
            'role',
            'assistant',
            'text',
            'Done',
            'turnId',
            'turn-one',
            'streaming',
            json('false'),
            'createdAt',
            '2026-07-19T00:00:00.000Z',
            'updatedAt',
            '2026-07-19T00:00:00.000Z'
          ),
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          4,
          'event-turn-diff',
          'thread',
          'herdr-thread-one',
          4,
          'thread.turn-diff-completed',
          '2026-07-19T00:00:00.000Z',
          'provider:herdr-codex:codex-session-one:turn-one:item:assistant-item-1:thread-turn-diff-complete:command-4',
          'provider',
          json_object(
            'threadId',
            'herdr-thread-one',
            'turnId',
            'turn-one',
            'assistantMessageId',
            'assistant:herdr-codex:codex-session-one:assistant-item-1',
            'checkpointTurnCount',
            1,
            'checkpointRef',
            'provider-diff:event-assistant',
            'status',
            'missing',
            'files',
            json('[]'),
            'completedAt',
            '2026-07-19T00:00:00.000Z'
          ),
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          checkpoint_files_json
        ) VALUES (
          'herdr-thread-one',
          'turn-one',
          NULL,
          'assistant:herdr-codex:codex-session-one:assistant-item-1',
          'completed',
          '2026-07-19T00:00:00.000Z',
          '[]'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          sequence,
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          actor_kind,
          payload_json,
          metadata_json
        ) VALUES (
          5,
          'event-activity',
          'thread',
          'herdr-thread-two',
          3,
          'thread.activity-appended',
          '2026-07-19T00:00:00.000Z',
          'provider:herdr-codex:codex-session-one:turn-one:item:command-item-1:thread-activity-append:command-5',
          'provider',
          json_object(
            'threadId',
            'herdr-thread-two',
            'activity',
            json_object(
              'id',
              'herdr-codex:codex-session-one:turn-one:item:command-item-1',
              'tone',
              'tool',
              'kind',
              'tool.completed',
              'summary',
              'Ran command',
              'payload',
              json_object('itemType', 'command_execution'),
              'turnId',
              'turn-one',
              'createdAt',
              '2026-07-19T00:00:00.000Z'
            )
          ),
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at,
          sequence
        ) VALUES (
          'herdr-codex:codex-session-one:turn-one:item:command-item-1',
          'herdr-thread-two',
          'turn-one',
          'tool',
          'tool.completed',
          'Ran command',
          '{}',
          '2026-07-19T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          ('projection.thread-messages', 99, '2026-07-19T00:00:00.000Z'),
          ('projection.thread-activities', 99, '2026-07-19T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const events = yield* sql<{
        readonly eventId: string;
        readonly messageId: string | null;
        readonly assistantMessageId: string | null;
      }>`
        SELECT
          event_id AS "eventId",
          json_extract(payload_json, '$.messageId') AS "messageId",
          json_extract(payload_json, '$.assistantMessageId') AS "assistantMessageId"
        FROM orchestration_events
        WHERE event_type IN ('thread.message-sent', 'thread.turn-diff-completed')
        ORDER BY sequence
      `;
      const turns = yield* sql<{ readonly assistantMessageId: string }>`
        SELECT assistant_message_id AS "assistantMessageId"
        FROM projection_turns
      `;
      const activityEvents = yield* sql<{ readonly activityId: string }>`
        SELECT json_extract(payload_json, '$.activity.id') AS "activityId"
        FROM orchestration_events
        WHERE event_type = 'thread.activity-appended'
      `;
      const activities = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_activities
      `;
      const projectorStates = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT projector, last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector IN ('projection.thread-messages', 'projection.thread-activities')
        ORDER BY projector
      `;

      assert.deepStrictEqual(events, [
        {
          eventId: "event-1",
          messageId: "user:herdr-codex:herdr-thread-one:codex-session-one:user-item-1",
          assistantMessageId: null,
        },
        {
          eventId: "event-2",
          messageId: "user:herdr-codex:herdr-thread-two:codex-session-one:user-item-1",
          assistantMessageId: null,
        },
        {
          eventId: "event-assistant",
          messageId: "assistant:herdr-codex:herdr-thread-one:codex-session-one:assistant-item-1",
          assistantMessageId: null,
        },
        {
          eventId: "event-turn-diff",
          messageId: null,
          assistantMessageId:
            "assistant:herdr-codex:herdr-thread-one:codex-session-one:assistant-item-1",
        },
      ]);
      assert.deepStrictEqual(turns, [
        {
          assistantMessageId:
            "assistant:herdr-codex:herdr-thread-one:codex-session-one:assistant-item-1",
        },
      ]);
      assert.deepStrictEqual(activityEvents, [
        {
          activityId: "herdr-codex:herdr-thread-two:codex-session-one:turn-one:item:command-item-1",
        },
      ]);
      assert.deepStrictEqual(activities, [{ count: 0 }]);
      assert.deepStrictEqual(projectorStates, [
        { projector: "projection.thread-activities", lastAppliedSequence: 0 },
        { projector: "projection.thread-messages", lastAppliedSequence: 0 },
      ]);
    }),
  );
});
