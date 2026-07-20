import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { collectHerdrRuntimeEventReceiptBackfill } from "./ProviderRuntimeEventReceiptBackfill.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { legacyEventIds, receipts } = yield* collectHerdrRuntimeEventReceiptBackfill;

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
  yield* Effect.forEach(
    legacyEventIds,
    (eventId) => sql`
      DELETE FROM provider_runtime_event_receipts
      WHERE provider = 'herdr' AND event_id = ${eventId}
    `,
    { concurrency: 1, discard: true },
  );
});
