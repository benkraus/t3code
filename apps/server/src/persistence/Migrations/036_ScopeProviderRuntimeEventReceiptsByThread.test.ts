import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ScopeProviderRuntimeEventReceiptsByThread", (it) => {
  it.effect("repairs receipts created by the original migration 35", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 34 });

      const legacyEventId = "herdr-codex:codex-session-one:turn-one:item:item-one";
      const eventId = `herdr-codex:herdr-thread-one:${legacyEventId.slice("herdr-codex:".length)}`;
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
          1,
          'event-1',
          'thread',
          'herdr-thread-one',
          1,
          'thread.message-sent',
          '2026-07-19T00:00:01.000Z',
          ${`provider:${legacyEventId}:assistant-complete:11111111-1111-4111-8111-111111111111`},
          'provider',
          '{}',
          '{}'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        DELETE FROM provider_runtime_event_receipts
        WHERE provider = 'herdr' AND event_id = ${eventId}
      `;
      yield* sql`
        INSERT INTO provider_runtime_event_receipts (
          provider,
          event_id,
          fingerprint,
          processed_at
        ) VALUES ('herdr', ${legacyEventId}, NULL, '2026-07-19T00:00:01.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const receipts = yield* sql<{
        readonly eventId: string;
        readonly processedAt: string;
      }>`
        SELECT event_id AS "eventId", processed_at AS "processedAt"
        FROM provider_runtime_event_receipts
        WHERE provider = 'herdr'
        ORDER BY event_id
      `;
      assert.deepEqual(receipts, [
        {
          eventId,
          processedAt: "2026-07-19T00:00:01.000Z",
        },
      ]);
    }),
  );
});
