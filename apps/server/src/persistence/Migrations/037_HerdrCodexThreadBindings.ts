import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE herdr_codex_thread_bindings (
      thread_id TEXT PRIMARY KEY,
      codex_thread_id TEXT NOT NULL,
      codex_session_id TEXT NOT NULL,
      reported_session_id TEXT NOT NULL,
      event_namespace_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
