import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_HerdrProjectionVisibility", (it) => {
  it.effect("persists sync-generated archive provenance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'herdr_projection_visibility'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 38 });
      const projectionThreadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(projectionThreadColumns.some((column) => column.name === "archive_command_id"));
      yield* sql`
        INSERT INTO herdr_projection_visibility (
          thread_id,
          provider_instance_id,
          archive_command_id,
          auto_archived_at
        ) VALUES (
          'herdr-thread-1',
          'herdr',
          'herdr-thread-archive:1',
          '2026-07-21T20:00:00.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly threadId: string;
        readonly providerInstanceId: string;
        readonly archiveCommandId: string;
        readonly autoArchivedAt: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          provider_instance_id AS "providerInstanceId",
          archive_command_id AS "archiveCommandId",
          auto_archived_at AS "autoArchivedAt"
        FROM herdr_projection_visibility
      `;
      assert.deepEqual(rows, [
        {
          threadId: "herdr-thread-1",
          providerInstanceId: "herdr",
          archiveCommandId: "herdr-thread-archive:1",
          autoArchivedAt: "2026-07-21T20:00:00.000Z",
        },
      ]);
    }),
  );
});
