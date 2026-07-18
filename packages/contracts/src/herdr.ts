import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const HERDR_WS_METHODS = {
  subscribePane: "herdr.subscribePane",
  createThread: "herdr.createThread",
  closePane: "herdr.closePane",
} as const;

export const HerdrAgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"]);
export type HerdrAgentStatus = typeof HerdrAgentStatus.Type;

export const HerdrPaneBinding = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  paneId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  workspaceId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
  agent: Schema.NullOr(TrimmedNonEmptyString),
  agentSessionSource: Schema.NullOr(TrimmedNonEmptyString),
  agentSessionKind: Schema.NullOr(Schema.Literals(["id", "path"])),
  agentSessionValue: Schema.NullOr(TrimmedNonEmptyString),
  cwd: TrimmedNonEmptyString,
  status: HerdrAgentStatus,
});
export type HerdrPaneBinding = typeof HerdrPaneBinding.Type;

export const HerdrPaneSnapshot = Schema.Struct({
  binding: HerdrPaneBinding,
  text: Schema.String,
  revision: NonNegativeInt,
  truncated: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type HerdrPaneSnapshot = typeof HerdrPaneSnapshot.Type;

export const HerdrSubscribePaneInput = Schema.Struct({
  threadId: ThreadId,
});
export type HerdrSubscribePaneInput = typeof HerdrSubscribePaneInput.Type;

export const HerdrCreateThreadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
});
export type HerdrCreateThreadInput = typeof HerdrCreateThreadInput.Type;

export const HerdrCreateThreadResult = Schema.Struct({
  threadId: ThreadId,
});
export type HerdrCreateThreadResult = typeof HerdrCreateThreadResult.Type;

export const HerdrClosePaneInput = Schema.Struct({
  threadId: ThreadId,
});
export type HerdrClosePaneInput = typeof HerdrClosePaneInput.Type;

export const HerdrClosePaneResult = Schema.Struct({
  closed: Schema.Boolean,
});
export type HerdrClosePaneResult = typeof HerdrClosePaneResult.Type;

export class HerdrRuntimeError extends Schema.TaggedErrorClass<HerdrRuntimeError>()(
  "HerdrRuntimeError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
) {}
