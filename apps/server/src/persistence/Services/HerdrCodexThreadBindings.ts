import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const HerdrCodexThreadBinding = Schema.Struct({
  threadId: ThreadId,
  codexThreadId: Schema.String,
  codexSessionId: Schema.String,
  reportedSessionId: Schema.String,
  eventNamespaceId: Schema.String,
  updatedAt: IsoDateTime,
});
export type HerdrCodexThreadBinding = typeof HerdrCodexThreadBinding.Type;

export const GetHerdrCodexThreadBindingInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetHerdrCodexThreadBindingInput = typeof GetHerdrCodexThreadBindingInput.Type;

export interface HerdrCodexThreadBindingRepositoryShape {
  readonly getByThreadId: (
    input: GetHerdrCodexThreadBindingInput,
  ) => Effect.Effect<Option.Option<HerdrCodexThreadBinding>, ProjectionRepositoryError>;
  readonly upsert: (
    binding: HerdrCodexThreadBinding,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class HerdrCodexThreadBindingRepository extends Context.Service<
  HerdrCodexThreadBindingRepository,
  HerdrCodexThreadBindingRepositoryShape
>()("t3/persistence/Services/HerdrCodexThreadBindings/HerdrCodexThreadBindingRepository") {}
