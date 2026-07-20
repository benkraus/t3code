import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProviderRuntimeEventReceipts", (it) => {
  it.effect("backfills one legacy receipt per canonical HerdR event id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      const eventId = "herdr-codex:herdr-thread-one:codex-session-one:turn-one:item:item-one";
      const legacyEventId = "herdr-codex:codex-session-one:turn-one:item:item-one";
      for (const [sequence, tag, uuid] of [
        [1, "assistant-delta-finalize", "11111111-1111-4111-8111-111111111111"],
        [2, "assistant-complete", "22222222-2222-4222-8222-222222222222"],
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
            ${`2026-07-19T00:00:0${sequence}.000Z`},
            ${`provider:${legacyEventId}:${tag}:${uuid}`},
            'provider',
            '{}',
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
          'event-3',
          'thread',
          'herdr-thread-one',
          3,
          'thread.session-set',
          '2026-07-19T00:00:03.000Z',
          'provider:herdr-codex:herdr-thread-one:codex-session-one:turn-one:turn:completed:thread-session-set:33333333-3333-4333-8333-333333333333',
          'provider',
          '{}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const receipts = yield* sql<{
        readonly provider: string;
        readonly eventId: string;
        readonly fingerprint: string | null;
        readonly processedAt: string;
      }>`
        SELECT
          provider,
          event_id AS "eventId",
          fingerprint,
          processed_at AS "processedAt"
        FROM provider_runtime_event_receipts
      `;

      assert.deepEqual(receipts, [
        {
          provider: "herdr",
          eventId,
          fingerprint: null,
          processedAt: "2026-07-19T00:00:02.000Z",
        },
      ]);
    }),
  );
});
