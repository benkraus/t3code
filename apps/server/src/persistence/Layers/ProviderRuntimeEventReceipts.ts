import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetProviderRuntimeEventReceiptInput,
  ListProviderRuntimeEventReceiptsInput,
  ProviderRuntimeEventReceipt,
  ProviderRuntimeEventReceiptRepository,
  type ProviderRuntimeEventReceiptRepositoryShape,
} from "../Services/ProviderRuntimeEventReceipts.ts";

const ProviderRuntimeEventReceiptRow = ProviderRuntimeEventReceipt;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProviderRuntimeEventReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: GetProviderRuntimeEventReceiptInput,
    Result: ProviderRuntimeEventReceiptRow,
    execute: ({ provider, eventId }) => sql`
      SELECT
        provider,
        event_id AS "eventId",
        fingerprint,
        processed_at AS "processedAt"
      FROM provider_runtime_event_receipts
      WHERE provider = ${provider}
        AND event_id = ${eventId}
      LIMIT 1
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: GetProviderRuntimeEventReceiptInput,
    execute: ({ provider, eventId }) => sql`
      DELETE FROM provider_runtime_event_receipts
      WHERE provider = ${provider}
        AND event_id = ${eventId}
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: ProviderRuntimeEventReceipt,
    execute: (receipt) => sql`
      INSERT INTO provider_runtime_event_receipts (
        provider,
        event_id,
        fingerprint,
        processed_at
      ) VALUES (
        ${receipt.provider},
        ${receipt.eventId},
        ${receipt.fingerprint},
        ${receipt.processedAt}
      )
      ON CONFLICT (provider, event_id)
      DO UPDATE SET
        fingerprint = excluded.fingerprint,
        processed_at = excluded.processed_at
    `,
  });

  const listRowsByEventIdPrefix = SqlSchema.findAll({
    Request: ListProviderRuntimeEventReceiptsInput,
    Result: ProviderRuntimeEventReceiptRow,
    execute: ({ provider, eventIdPrefix }) => sql`
      SELECT
        provider,
        event_id AS "eventId",
        fingerprint,
        processed_at AS "processedAt"
      FROM provider_runtime_event_receipts
      WHERE provider = ${provider}
        AND event_id LIKE ${`${eventIdPrefix}%`}
      ORDER BY event_id ASC
    `,
  });

  const get: ProviderRuntimeEventReceiptRepositoryShape["get"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderRuntimeEventReceiptRepository.get:query",
          "ProviderRuntimeEventReceiptRepository.get:decode",
        ),
      ),
      Effect.map(Option.map((receipt) => receipt)),
    );

  const deleteByEventId: ProviderRuntimeEventReceiptRepositoryShape["deleteByEventId"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderRuntimeEventReceiptRepository.deleteByEventId:query",
          "ProviderRuntimeEventReceiptRepository.deleteByEventId:encode",
        ),
      ),
    );

  const upsert: ProviderRuntimeEventReceiptRepositoryShape["upsert"] = (receipt) =>
    upsertRow(receipt).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderRuntimeEventReceiptRepository.upsert:query",
          "ProviderRuntimeEventReceiptRepository.upsert:encode",
        ),
      ),
    );

  const listByEventIdPrefix: ProviderRuntimeEventReceiptRepositoryShape["listByEventIdPrefix"] = (
    input,
  ) =>
    listRowsByEventIdPrefix(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderRuntimeEventReceiptRepository.listByEventIdPrefix:query",
          "ProviderRuntimeEventReceiptRepository.listByEventIdPrefix:decode",
        ),
      ),
    );

  return ProviderRuntimeEventReceiptRepository.of({
    deleteByEventId,
    get,
    listByEventIdPrefix,
    upsert,
  });
});

export const ProviderRuntimeEventReceiptRepositoryLive = Layer.effect(
  ProviderRuntimeEventReceiptRepository,
  makeProviderRuntimeEventReceiptRepository,
);
