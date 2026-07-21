import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  GetHerdrCodexThreadBindingInput,
  HerdrCodexThreadBinding,
  HerdrCodexThreadBindingRepository,
  type HerdrCodexThreadBindingRepositoryShape,
} from "../Services/HerdrCodexThreadBindings.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeHerdrCodexThreadBindingRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: GetHerdrCodexThreadBindingInput,
    Result: HerdrCodexThreadBinding,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        codex_thread_id AS "codexThreadId",
        codex_session_id AS "codexSessionId",
        reported_session_id AS "reportedSessionId",
        event_namespace_id AS "eventNamespaceId",
        updated_at AS "updatedAt"
      FROM herdr_codex_thread_bindings
      WHERE thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: HerdrCodexThreadBinding,
    execute: (binding) => sql`
      INSERT INTO herdr_codex_thread_bindings (
        thread_id,
        codex_thread_id,
        codex_session_id,
        reported_session_id,
        event_namespace_id,
        updated_at
      ) VALUES (
        ${binding.threadId},
        ${binding.codexThreadId},
        ${binding.codexSessionId},
        ${binding.reportedSessionId},
        ${binding.eventNamespaceId},
        ${binding.updatedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        codex_thread_id = excluded.codex_thread_id,
        codex_session_id = excluded.codex_session_id,
        reported_session_id = excluded.reported_session_id,
        event_namespace_id = excluded.event_namespace_id,
        updated_at = excluded.updated_at
    `,
  });

  const getByThreadId: HerdrCodexThreadBindingRepositoryShape["getByThreadId"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HerdrCodexThreadBindingRepository.getByThreadId:query",
          "HerdrCodexThreadBindingRepository.getByThreadId:decode",
        ),
      ),
      Effect.map(Option.map((binding) => binding)),
    );

  const upsert: HerdrCodexThreadBindingRepositoryShape["upsert"] = (binding) =>
    upsertRow(binding).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HerdrCodexThreadBindingRepository.upsert:query",
          "HerdrCodexThreadBindingRepository.upsert:encode",
        ),
      ),
    );

  return HerdrCodexThreadBindingRepository.of({ getByThreadId, upsert });
});

export const HerdrCodexThreadBindingRepositoryLive = Layer.effect(
  HerdrCodexThreadBindingRepository,
  makeHerdrCodexThreadBindingRepository,
);
