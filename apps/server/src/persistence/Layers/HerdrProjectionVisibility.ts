import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  BeginHerdrProjectionAutoArchiveInput,
  CompleteHerdrProjectionAutoArchiveInput,
  DeleteHerdrProjectionVisibilityInput,
  EnsureHerdrProjectionVisibilityInput,
  HerdrProjectionVisibility,
  HerdrProjectionVisibilityRepository,
  type HerdrProjectionVisibilityRepositoryShape,
  ListHerdrProjectionVisibilityInput,
} from "../Services/HerdrProjectionVisibility.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeHerdrProjectionVisibilityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: ListHerdrProjectionVisibilityInput,
    Result: HerdrProjectionVisibility,
    execute: ({ providerInstanceId }) => sql`
      SELECT
        thread_id AS "threadId",
        provider_instance_id AS "providerInstanceId",
        archive_command_id AS "archiveCommandId",
        auto_archived_at AS "autoArchivedAt"
      FROM herdr_projection_visibility
      WHERE provider_instance_id = ${providerInstanceId}
      ORDER BY thread_id ASC
    `,
  });

  const ensureOwnedRow = SqlSchema.void({
    Request: EnsureHerdrProjectionVisibilityInput,
    execute: (entry) => sql`
      INSERT INTO herdr_projection_visibility (
        thread_id,
        provider_instance_id,
        archive_command_id,
        auto_archived_at
      ) VALUES (
        ${entry.threadId},
        ${entry.providerInstanceId},
        NULL,
        NULL
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        provider_instance_id = excluded.provider_instance_id
    `,
  });

  const beginAutoArchiveRow = SqlSchema.void({
    Request: BeginHerdrProjectionAutoArchiveInput,
    execute: (entry) => sql`
      INSERT INTO herdr_projection_visibility (
        thread_id,
        provider_instance_id,
        archive_command_id,
        auto_archived_at
      ) VALUES (
        ${entry.threadId},
        ${entry.providerInstanceId},
        ${entry.archiveCommandId},
        NULL
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        provider_instance_id = excluded.provider_instance_id,
        archive_command_id = excluded.archive_command_id,
        auto_archived_at = NULL
    `,
  });

  const completeAutoArchiveRow = SqlSchema.void({
    Request: CompleteHerdrProjectionAutoArchiveInput,
    execute: (entry) => sql`
      UPDATE herdr_projection_visibility
      SET auto_archived_at = ${entry.autoArchivedAt}
      WHERE thread_id = ${entry.threadId}
        AND archive_command_id = ${entry.archiveCommandId}
    `,
  });

  const clearAutoArchiveRow = SqlSchema.void({
    Request: DeleteHerdrProjectionVisibilityInput,
    execute: ({ threadId }) => sql`
      UPDATE herdr_projection_visibility
      SET archive_command_id = NULL,
          auto_archived_at = NULL
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeleteHerdrProjectionVisibilityInput,
    execute: ({ threadId }) => sql`
      DELETE FROM herdr_projection_visibility
      WHERE thread_id = ${threadId}
    `,
  });

  const listByInstanceId: HerdrProjectionVisibilityRepositoryShape["listByInstanceId"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HerdrProjectionVisibilityRepository.listByInstanceId:query",
          "HerdrProjectionVisibilityRepository.listByInstanceId:decode",
        ),
      ),
    );

  const ensureOwned: HerdrProjectionVisibilityRepositoryShape["ensureOwned"] = (input) =>
    ensureOwnedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HerdrProjectionVisibilityRepository.ensureOwned:query",
          "HerdrProjectionVisibilityRepository.ensureOwned:encode",
        ),
      ),
    );

  const beginAutoArchive: HerdrProjectionVisibilityRepositoryShape["beginAutoArchive"] = (input) =>
    beginAutoArchiveRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HerdrProjectionVisibilityRepository.beginAutoArchive:query",
          "HerdrProjectionVisibilityRepository.beginAutoArchive:encode",
        ),
      ),
    );

  const completeAutoArchive: HerdrProjectionVisibilityRepositoryShape["completeAutoArchive"] = (
    input,
  ) =>
    completeAutoArchiveRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "HerdrProjectionVisibilityRepository.completeAutoArchive:query",
          "HerdrProjectionVisibilityRepository.completeAutoArchive:encode",
        ),
      ),
    );

  const clearAutoArchive: HerdrProjectionVisibilityRepositoryShape["clearAutoArchive"] = (input) =>
    clearAutoArchiveRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("HerdrProjectionVisibilityRepository.clearAutoArchive:query"),
      ),
    );

  const deleteByThreadId: HerdrProjectionVisibilityRepositoryShape["deleteByThreadId"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("HerdrProjectionVisibilityRepository.deleteByThreadId:query"),
      ),
    );

  return HerdrProjectionVisibilityRepository.of({
    listByInstanceId,
    ensureOwned,
    beginAutoArchive,
    completeAutoArchive,
    clearAutoArchive,
    deleteByThreadId,
  });
});

export const HerdrProjectionVisibilityRepositoryLive = Layer.effect(
  HerdrProjectionVisibilityRepository,
  makeHerdrProjectionVisibilityRepository,
);
