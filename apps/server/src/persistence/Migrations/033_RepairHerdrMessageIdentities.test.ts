import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("033_RepairHerdrMessageIdentities", (it) => {
  it.effect("repairs exact historical sessions and rewinds only message projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });

      for (const [sequence, sessionId, turnId] of [
        [1, "codex-session-one", "turn-one"],
        [2, "codex-session-two", "turn-two"],
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
            'herdr-thread-one',
            ${sequence},
            'thread.message-sent',
            '2026-07-19T00:00:00.000Z',
            ${`provider:herdr-codex:${sessionId}:${turnId}:item:user-item-1:user-message-import:command-${sequence}`},
            'provider',
            json_object(
              'threadId',
              'herdr-thread-one',
              'messageId',
              'user:user-item-1',
              'role',
              'user',
              'text',
              ${sessionId},
              'turnId',
              ${turnId},
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
            'assistant:assistant-item-1',
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
          'assistant:assistant-item-1',
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
          4,
          'event-server-turn-diff',
          'thread',
          'herdr-thread-one',
          4,
          'thread.turn-diff-completed',
          '2026-07-19T00:00:00.000Z',
          'server:checkpoint-reactor:command-4',
          'server',
          json_object(
            'threadId',
            'herdr-thread-one',
            'turnId',
            'turn-one',
            'assistantMessageId',
            'assistant:assistant-item-1',
            'checkpointTurnCount',
            1,
            'checkpointRef',
            'refs/t3/checkpoints/herdr-thread-one/turn/1',
            'status',
            'ready',
            'files',
            json('[]'),
            'completedAt',
            '2026-07-19T00:00:00.000Z'
          ),
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        ) VALUES (
          'user:user-item-1',
          'herdr-thread-one',
          'turn-two',
          'user',
          'Collision survivor',
          0,
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z'
        ), (
          'regular-message',
          'regular-thread',
          NULL,
          'user',
          'Rebuilt from its event after startup',
          0,
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          ('projection.thread-messages', 99, '2026-07-19T00:00:00.000Z'),
          ('projection.thread-turns', 99, '2026-07-19T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const events = yield* sql<{
        readonly eventId: string;
        readonly messageId: string | null;
      }>`
        SELECT
          event_id AS "eventId",
          json_extract(payload_json, '$.messageId') AS "messageId"
        FROM orchestration_events
        ORDER BY sequence
      `;
      const turns = yield* sql<{ readonly assistantMessageId: string }>`
        SELECT assistant_message_id AS "assistantMessageId"
        FROM projection_turns
      `;
      const turnDiffEvents = yield* sql<{ readonly assistantMessageId: string }>`
        SELECT json_extract(payload_json, '$.assistantMessageId') AS "assistantMessageId"
        FROM orchestration_events
        WHERE event_type = 'thread.turn-diff-completed'
      `;
      const messages = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_messages
      `;
      const projectorStates = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector
      `;

      assert.deepStrictEqual(events, [
        {
          eventId: "event-1",
          messageId: "user:herdr-codex:herdr-thread-one:codex-session-one:user-item-1",
        },
        {
          eventId: "event-2",
          messageId: "user:herdr-codex:herdr-thread-one:codex-session-two:user-item-1",
        },
        {
          eventId: "event-assistant",
          messageId: "assistant:herdr-codex:herdr-thread-one:codex-session-one:assistant-item-1",
        },
        {
          eventId: "event-server-turn-diff",
          messageId: null,
        },
      ]);
      assert.deepStrictEqual(turns, [
        {
          assistantMessageId:
            "assistant:herdr-codex:herdr-thread-one:codex-session-one:assistant-item-1",
        },
      ]);
      assert.deepStrictEqual(turnDiffEvents, [
        {
          assistantMessageId:
            "assistant:herdr-codex:herdr-thread-one:codex-session-one:assistant-item-1",
        },
      ]);
      assert.deepStrictEqual(messages, [{ count: 0 }]);
      assert.deepStrictEqual(projectorStates, [
        { projector: "projection.thread-messages", lastAppliedSequence: 0 },
        { projector: "projection.thread-turns", lastAppliedSequence: 99 },
      ]);
    }),
  );
});
