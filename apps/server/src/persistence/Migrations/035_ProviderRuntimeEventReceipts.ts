import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { collectHerdrRuntimeEventReceiptBackfill } from "./ProviderRuntimeEventReceiptBackfill.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE provider_runtime_event_receipts (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      fingerprint TEXT,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (provider, event_id)
    )
  `;

  const { receipts } = yield* collectHerdrRuntimeEventReceiptBackfill;

  yield* Effect.forEach(
    receipts,
    ([eventId, processedAt]) => sql`
      INSERT OR IGNORE INTO provider_runtime_event_receipts (
        provider,
        event_id,
        fingerprint,
        processed_at
      ) VALUES ('herdr', ${eventId}, NULL, ${processedAt})
    `,
    { concurrency: 1, discard: true },
  );
});
