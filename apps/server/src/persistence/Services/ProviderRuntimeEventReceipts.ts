/**
 * ProviderRuntimeEventReceiptRepository - Durable provider event deduplication.
 *
 * Snapshot-backed providers may replay the same canonical event after a server
 * restart. Receipts let ingestion skip exact replays while still accepting a
 * changed payload for a stable provider event id.
 */
import { EventId, IsoDateTime, ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProviderRuntimeEventReceipt = Schema.Struct({
  provider: ProviderDriverKind,
  eventId: EventId,
  fingerprint: Schema.NullOr(Schema.String),
  processedAt: IsoDateTime,
});
export type ProviderRuntimeEventReceipt = typeof ProviderRuntimeEventReceipt.Type;

export const GetProviderRuntimeEventReceiptInput = Schema.Struct({
  provider: ProviderDriverKind,
  eventId: EventId,
});
export type GetProviderRuntimeEventReceiptInput = typeof GetProviderRuntimeEventReceiptInput.Type;

export const ListProviderRuntimeEventReceiptsInput = Schema.Struct({
  provider: ProviderDriverKind,
  eventIdPrefix: Schema.String,
});
export type ListProviderRuntimeEventReceiptsInput =
  typeof ListProviderRuntimeEventReceiptsInput.Type;

export interface ProviderRuntimeEventReceiptRepositoryShape {
  readonly deleteByEventId: (
    input: GetProviderRuntimeEventReceiptInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly get: (
    input: GetProviderRuntimeEventReceiptInput,
  ) => Effect.Effect<Option.Option<ProviderRuntimeEventReceipt>, ProjectionRepositoryError>;
  readonly listByEventIdPrefix: (
    input: ListProviderRuntimeEventReceiptsInput,
  ) => Effect.Effect<ReadonlyArray<ProviderRuntimeEventReceipt>, ProjectionRepositoryError>;
  readonly upsert: (
    receipt: ProviderRuntimeEventReceipt,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProviderRuntimeEventReceiptRepository extends Context.Service<
  ProviderRuntimeEventReceiptRepository,
  ProviderRuntimeEventReceiptRepositoryShape
>()("t3/persistence/Services/ProviderRuntimeEventReceipts/ProviderRuntimeEventReceiptRepository") {}
