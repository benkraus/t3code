import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_HerdrCodexThreadBindings", (it) => {
  it.effect("creates explicit durable Codex thread bindings", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'herdr_codex_thread_bindings'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO herdr_codex_thread_bindings (
          thread_id,
          codex_thread_id,
          codex_session_id,
          reported_session_id,
          event_namespace_id,
          updated_at
        ) VALUES (
          'herdr-thread-1',
          'codex-fork-1',
          'codex-session-tree-1',
          'reported-session-1',
          'legacy-event-namespace-1',
          '2026-07-20T22:00:00.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly threadId: string;
        readonly codexThreadId: string;
        readonly codexSessionId: string;
        readonly reportedSessionId: string;
        readonly eventNamespaceId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          codex_thread_id AS "codexThreadId",
          codex_session_id AS "codexSessionId",
          reported_session_id AS "reportedSessionId",
          event_namespace_id AS "eventNamespaceId"
        FROM herdr_codex_thread_bindings
      `;
      assert.deepEqual(rows, [
        {
          threadId: "herdr-thread-1",
          codexThreadId: "codex-fork-1",
          codexSessionId: "codex-session-tree-1",
          reportedSessionId: "reported-session-1",
          eventNamespaceId: "legacy-event-namespace-1",
        },
      ]);
    }),
  );
});
