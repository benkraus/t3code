import { CommandId, IsoDateTime, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const HerdrProjectionVisibility = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  archiveCommandId: Schema.NullOr(CommandId),
  autoArchivedAt: Schema.NullOr(IsoDateTime),
});
export type HerdrProjectionVisibility = typeof HerdrProjectionVisibility.Type;

export const ListHerdrProjectionVisibilityInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type ListHerdrProjectionVisibilityInput = typeof ListHerdrProjectionVisibilityInput.Type;

export const EnsureHerdrProjectionVisibilityInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});
export type EnsureHerdrProjectionVisibilityInput = typeof EnsureHerdrProjectionVisibilityInput.Type;

export const BeginHerdrProjectionAutoArchiveInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  archiveCommandId: CommandId,
});
export type BeginHerdrProjectionAutoArchiveInput = typeof BeginHerdrProjectionAutoArchiveInput.Type;

export const CompleteHerdrProjectionAutoArchiveInput = Schema.Struct({
  threadId: ThreadId,
  archiveCommandId: CommandId,
  autoArchivedAt: IsoDateTime,
});
export type CompleteHerdrProjectionAutoArchiveInput =
  typeof CompleteHerdrProjectionAutoArchiveInput.Type;

export const DeleteHerdrProjectionVisibilityInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteHerdrProjectionVisibilityInput = typeof DeleteHerdrProjectionVisibilityInput.Type;

export interface HerdrProjectionVisibilityRepositoryShape {
  readonly listByInstanceId: (
    input: ListHerdrProjectionVisibilityInput,
  ) => Effect.Effect<ReadonlyArray<HerdrProjectionVisibility>, ProjectionRepositoryError>;
  readonly ensureOwned: (
    input: EnsureHerdrProjectionVisibilityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly beginAutoArchive: (
    input: BeginHerdrProjectionAutoArchiveInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly completeAutoArchive: (
    input: CompleteHerdrProjectionAutoArchiveInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly clearAutoArchive: (
    input: DeleteHerdrProjectionVisibilityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteHerdrProjectionVisibilityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class HerdrProjectionVisibilityRepository extends Context.Service<
  HerdrProjectionVisibilityRepository,
  HerdrProjectionVisibilityRepositoryShape
>()("t3/persistence/Services/HerdrProjectionVisibility/HerdrProjectionVisibilityRepository") {}
