import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN archive_command_id TEXT
  `;

  yield* sql`
    CREATE TABLE herdr_projection_visibility (
      thread_id TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      archive_command_id TEXT,
      auto_archived_at TEXT,
      CHECK (auto_archived_at IS NULL OR archive_command_id IS NOT NULL)
    )
  `;

  yield* sql`
    CREATE INDEX idx_herdr_projection_visibility_instance
    ON herdr_projection_visibility(provider_instance_id)
  `;
});
