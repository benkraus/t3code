import {
  EventId,
  ProviderItemId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeTaskId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as NodeCrypto from "node:crypto";

import type { HerdrWirePane } from "./HerdrSocketClient.ts";

const HERDR_DRIVER = ProviderDriverKind.make("herdr");

type CodexThread = CodexSchema.V2ThreadReadResponse["thread"];
type CodexTurn = CodexThread["turns"][number];
type CodexItem = CodexTurn["items"][number];

const ACTIVE_TRANSCRIPT_REFRESH_INTERVAL_MS = 5_000;
const IDLE_TRANSCRIPT_FAILURE_RETRY_INTERVAL_MS = 30_000;

export interface CodexTranscriptStabilizationCandidate {
  readonly paneSignature: string;
  readonly snapshotSignature: string;
}

export interface CodexColdStartCandidate {
  readonly turnId: TurnId;
  readonly snapshotSignature: string;
}

export function classifyCodexColdStartTurn(input: {
  readonly candidate: CodexColdStartCandidate | undefined;
  readonly turnId: TurnId;
  readonly snapshotSignature: string;
  readonly projectedTerminal: boolean;
  readonly hasDurableCompletion: boolean;
}): {
  readonly candidate: CodexColdStartCandidate | undefined;
  readonly defer: boolean;
} {
  if (!input.projectedTerminal || input.hasDurableCompletion) {
    return { candidate: undefined, defer: false };
  }
  if (
    input.candidate?.turnId === input.turnId &&
    input.candidate.snapshotSignature !== input.snapshotSignature
  ) {
    return { candidate: undefined, defer: false };
  }
  return {
    candidate: { turnId: input.turnId, snapshotSignature: input.snapshotSignature },
    defer: true,
  };
}

export function advanceCodexTranscriptStabilization(input: {
  readonly candidate: CodexTranscriptStabilizationCandidate | undefined;
  readonly paneSignature: string;
  readonly snapshotSignature: string;
  readonly hasPendingEvents: boolean;
  readonly hasActiveTurn: boolean;
}): {
  readonly candidate: CodexTranscriptStabilizationCandidate | undefined;
  readonly settled: boolean;
} {
  const candidate = {
    paneSignature: input.paneSignature,
    snapshotSignature: input.snapshotSignature,
  };
  const matchesPrevious =
    input.candidate?.paneSignature === input.paneSignature &&
    input.candidate.snapshotSignature === input.snapshotSignature;
  if (!input.hasPendingEvents && !input.hasActiveTurn && matchesPrevious) {
    return { candidate: undefined, settled: true };
  }
  return { candidate, settled: false };
}

export interface CodexTranscriptInFlightEvent {
  readonly fingerprint: string;
  readonly emittedAtMs: number;
  readonly retryCount: number;
}

export function codexTranscriptPanePriority(pane: Pick<HerdrWirePane, "agent_status">): number {
  return pane.agent_status === "working" || pane.agent_status === "blocked" ? 0 : 1;
}

export function shouldRefreshCodexTranscript(
  pane: Pick<HerdrWirePane, "agent_status" | "agent_session" | "revision">,
  previousSignature: string | undefined,
  attemptedSignature: string | undefined,
  lastRefreshAtMs: number | undefined,
  nowMs: number,
  stabilizingIdleTranscript = false,
): boolean {
  if (pane.agent_status === "working" || pane.agent_status === "blocked") {
    return (
      lastRefreshAtMs === undefined ||
      nowMs - lastRefreshAtMs >= ACTIVE_TRANSCRIPT_REFRESH_INTERVAL_MS
    );
  }
  const signature = `${pane.agent_session?.value}:${pane.revision}:${pane.agent_status}`;
  if (previousSignature === signature) return false;
  if (attemptedSignature !== signature) return true;
  return (
    lastRefreshAtMs === undefined ||
    nowMs - lastRefreshAtMs >=
      (stabilizingIdleTranscript
        ? ACTIVE_TRANSCRIPT_REFRESH_INTERVAL_MS
        : IDLE_TRANSCRIPT_FAILURE_RETRY_INTERVAL_MS)
  );
}

export function codexTranscriptPaneSignature(
  pane: Pick<HerdrWirePane, "agent_status" | "agent_session" | "revision">,
): string {
  return `${pane.agent_session?.value}:${pane.revision}:${pane.agent_status}`;
}

export function resolveCodexExternallyActiveTurnId(input: {
  readonly thread: CodexThread;
  readonly externallyActive: boolean;
  readonly previousLatestTurnId?: TurnId;
  readonly activeTurnId?: TurnId;
  readonly forcedActiveTurnId?: TurnId;
  readonly latestTurnHasDurableCompletion: boolean;
}): TurnId | undefined {
  const latestTurn = input.thread.turns.at(-1);
  if (!latestTurn || latestTurn.completedAt != null) return undefined;
  const latestTurnId = TurnId.make(latestTurn.id);
  if (input.forcedActiveTurnId === latestTurnId) return latestTurnId;
  if (latestTurn.status === "inProgress") return latestTurnId;
  if (!input.externallyActive) return undefined;
  if (input.activeTurnId === latestTurnId) return latestTurnId;
  if (input.previousLatestTurnId === undefined) {
    return input.latestTurnHasDurableCompletion ? undefined : latestTurnId;
  }
  return input.previousLatestTurnId === latestTurnId ? undefined : latestTurnId;
}

export function staleCodexCompletionReceiptEventId(input: {
  readonly eventIdPrefix: string;
  readonly latestTurnId: TurnId | undefined;
  readonly projectedLatestTurnState:
    | "pending"
    | "running"
    | "interrupted"
    | "completed"
    | "error"
    | undefined;
  readonly durableFingerprints: ReadonlyMap<string, string | null>;
}): string | undefined {
  if (input.latestTurnId === undefined || input.projectedLatestTurnState !== "running") {
    return undefined;
  }
  const completionEventId = `${input.eventIdPrefix}${input.latestTurnId}:turn:completed`;
  return input.durableFingerprints.has(completionEventId) ? completionEventId : undefined;
}

function isoFromUnixSeconds(value: number | null | undefined, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return Option.match(DateTime.make(value * 1_000), {
    onNone: () => fallback,
    onSome: DateTime.formatIso,
  });
}

function turnCreatedAt(
  value: number | null | undefined,
  fallbackStartedAt: string | undefined,
  threadCreatedAt: string,
  turnIndex: number,
  previousTurnCreatedAt: string | undefined,
): string {
  if (value !== null && value !== undefined) {
    return isoFromUnixSeconds(value, threadCreatedAt);
  }
  const candidate =
    fallbackStartedAt ??
    Option.match(DateTime.make(threadCreatedAt), {
      onNone: () => threadCreatedAt,
      onSome: (dateTime) => DateTime.formatIso(DateTime.add(dateTime, { milliseconds: turnIndex })),
    });
  if (previousTurnCreatedAt === undefined) return candidate;
  const candidateDateTime = DateTime.make(candidate);
  const previousDateTime = DateTime.make(previousTurnCreatedAt);
  if (
    Option.isNone(candidateDateTime) ||
    Option.isNone(previousDateTime) ||
    DateTime.toEpochMillis(candidateDateTime.value) > DateTime.toEpochMillis(previousDateTime.value)
  ) {
    return candidate;
  }
  return DateTime.formatIso(DateTime.add(previousDateTime.value, { milliseconds: 1 }));
}

function turnCompletedAt(
  turn: CodexTurn,
  createdAt: string,
  thread: CodexThread,
  turnIndex: number,
  fallbackCompletedAt: string | undefined,
): string {
  if (turn.completedAt !== null && turn.completedAt !== undefined) {
    return isoFromUnixSeconds(turn.completedAt, createdAt);
  }
  if (
    turn.startedAt !== null &&
    turn.startedAt !== undefined &&
    turn.durationMs !== null &&
    turn.durationMs !== undefined &&
    turn.durationMs >= 0
  ) {
    const completedAt = Option.map(DateTime.make(createdAt), (dateTime) =>
      DateTime.formatIso(DateTime.add(dateTime, { milliseconds: turn.durationMs! })),
    );
    if (Option.isSome(completedAt)) return completedAt.value;
  }
  const nextStartedAt = thread.turns[turnIndex + 1]?.startedAt;
  if (nextStartedAt !== null && nextStartedAt !== undefined) {
    return isoFromUnixSeconds(nextStartedAt, createdAt);
  }
  if (fallbackCompletedAt !== undefined) return fallbackCompletedAt;
  return Option.match(DateTime.make(createdAt), {
    onNone: () => createdAt,
    onSome: (dateTime) => DateTime.formatIso(DateTime.add(dateTime, { milliseconds: 1 })),
  });
}

function eventId(
  canonicalThreadId: ThreadId,
  sessionId: string,
  turnId: string,
  suffix: string,
): EventId {
  return EventId.make(`herdr-codex:${canonicalThreadId}:${sessionId}:${turnId}:${suffix}`);
}

function runtimeItemId(
  canonicalThreadId: ThreadId,
  sessionId: string,
  itemId: string,
): RuntimeItemId {
  return RuntimeItemId.make(`herdr-codex:${canonicalThreadId}:${sessionId}:${itemId}`);
}

function userMessageText(item: Extract<CodexItem, { type: "userMessage" }>): string {
  return item.content
    .map((content) => {
      switch (content.type) {
        case "text":
          return content.text;
        case "image":
          return `[Image: ${content.url}]`;
        case "localImage":
          return `[Image: ${content.path}]`;
        case "skill":
          return `$${content.name}`;
        case "mention":
          return `@${content.name}`;
      }
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function itemLifecycleStatus(item: CodexItem): "inProgress" | "completed" | "failed" {
  if ("status" in item) {
    if (item.status === "inProgress" || item.status === "running") return "inProgress";
    if (item.status === "failed" || item.status === "declined" || item.status === "error") {
      return "failed";
    }
  }
  return "completed";
}

function itemEvent(input: {
  readonly instanceId: ProviderInstanceId;
  readonly canonicalThreadId: ThreadId;
  readonly sessionId: string;
  readonly turn: CodexTurn;
  readonly item: CodexItem;
  readonly createdAt: string;
}): ProviderRuntimeEvent | null {
  const { instanceId, canonicalThreadId, sessionId, turn, item, createdAt } = input;
  const base = {
    eventId: eventId(canonicalThreadId, sessionId, turn.id, `item:${item.id}`),
    provider: HERDR_DRIVER,
    providerInstanceId: instanceId,
    threadId: canonicalThreadId,
    turnId: TurnId.make(turn.id),
    itemId: runtimeItemId(canonicalThreadId, sessionId, item.id),
    createdAt,
    providerRefs: {
      providerTurnId: turn.id,
      providerItemId: ProviderItemId.make(item.id),
    },
    raw: {
      source: "codex.app-server.notification" as const,
      method: "thread/read",
      payload: item,
    },
  };

  switch (item.type) {
    case "userMessage": {
      const detail = userMessageText(item).trim();
      return detail.length > 0
        ? {
            ...base,
            type: "item.completed",
            payload: { itemType: "user_message", status: "completed", detail, data: item },
          }
        : null;
    }
    case "agentMessage": {
      const detail = item.text.trim();
      return detail.length > 0
        ? {
            ...base,
            type: "item.completed",
            payload: { itemType: "assistant_message", status: "completed", detail, data: item },
          }
        : null;
    }
    case "plan":
      return item.text.trim().length > 0
        ? { ...base, type: "turn.proposed.completed", payload: { planMarkdown: item.text } }
        : null;
    case "reasoning": {
      const detail = [...(item.summary ?? []), ...(item.content ?? [])].join("\n\n").trim();
      return detail.length > 0
        ? {
            ...base,
            type: "item.completed",
            payload: { itemType: "reasoning", status: "completed", detail, data: item },
          }
        : null;
    }
    case "commandExecution": {
      const status = itemLifecycleStatus(item);
      return {
        ...base,
        type: status === "inProgress" ? "item.started" : "item.completed",
        payload: {
          itemType: "command_execution",
          status,
          title: "Ran command",
          detail: item.command,
          data: item,
        },
      };
    }
    case "fileChange": {
      const status = itemLifecycleStatus(item);
      return {
        ...base,
        type: status === "inProgress" ? "item.started" : "item.completed",
        payload: {
          itemType: "file_change",
          status,
          title: "File change",
          detail: item.changes.map((change) => change.path).join(", ") || undefined,
          data: item,
        },
      };
    }
    case "mcpToolCall": {
      const status = itemLifecycleStatus(item);
      return {
        ...base,
        type: status === "inProgress" ? "item.started" : "item.completed",
        payload: {
          itemType: "mcp_tool_call",
          status,
          title: `${item.server} · ${item.tool}`,
          data: { item },
        },
      };
    }
    case "dynamicToolCall": {
      const status = itemLifecycleStatus(item);
      return {
        ...base,
        type: status === "inProgress" ? "item.started" : "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status,
          title: item.tool,
          data: item,
        },
      };
    }
    case "collabAgentToolCall": {
      const status = itemLifecycleStatus(item);
      return {
        ...base,
        type: status === "inProgress" ? "item.started" : "item.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          status,
          title: item.tool,
          detail: item.prompt ?? undefined,
          data: item,
        },
      };
    }
    case "subAgentActivity":
      return {
        ...base,
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(item.agentThreadId),
          description: `${item.kind}: ${item.agentPath}`,
        },
      };
    case "webSearch":
      return {
        ...base,
        type: "item.completed",
        payload: {
          itemType: "web_search",
          status: "completed",
          title: "Web search",
          detail: item.query,
          data: item,
        },
      };
    case "imageView":
      return {
        ...base,
        type: "item.completed",
        payload: {
          itemType: "image_view",
          status: "completed",
          title: "Image view",
          detail: item.path,
          data: item,
        },
      };
    case "imageGeneration":
      return {
        ...base,
        type: "item.completed",
        payload: {
          itemType: "image_view",
          status: item.status === "failed" ? "failed" : "completed",
          title: "Image generation",
          detail: item.savedPath ?? item.revisedPrompt ?? item.result,
          data: item,
        },
      };
    case "enteredReviewMode":
      return {
        ...base,
        type: "item.completed",
        payload: { itemType: "review_entered", status: "completed", detail: item.review },
      };
    case "exitedReviewMode":
      return {
        ...base,
        type: "item.completed",
        payload: { itemType: "review_exited", status: "completed", detail: item.review },
      };
    case "contextCompaction":
      return {
        ...base,
        type: "thread.state.changed",
        payload: { state: "compacted", detail: "Codex compacted the session context." },
      };
    case "hookPrompt":
      return null;
  }
}

function turnState(status: CodexTurn["status"]): "completed" | "failed" | "interrupted" {
  switch (status) {
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "completed";
  }
}

function turnLifecycleRaw(
  turn: CodexTurn,
  terminal: boolean,
): NonNullable<ProviderRuntimeEvent["raw"]> {
  return {
    source: "codex.app-server.notification",
    method: "thread/read",
    payload: {
      turnId: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      terminal,
      errorMessage: turn.error?.message ?? null,
    },
  };
}

export function codexThreadRuntimeEvents(input: {
  readonly instanceId: ProviderInstanceId;
  readonly canonicalThreadId: ThreadId;
  readonly sessionId: string;
  readonly thread: CodexThread;
  readonly observedAt: string;
  readonly externallyActiveTurnId?: TurnId;
  readonly fallbackStartedAtByTurnId?: ReadonlyMap<string, string>;
  readonly fallbackCompletedAtByTurnId?: ReadonlyMap<string, string>;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const events: ProviderRuntimeEvent[] = [];
  const threadCreatedAt = isoFromUnixSeconds(input.thread.createdAt, input.observedAt);
  const latestTurnIndex = input.thread.turns.length - 1;
  let previousTurnCreatedAt: string | undefined;
  for (let turnIndex = 0; turnIndex <= latestTurnIndex; turnIndex += 1) {
    const turn = input.thread.turns[turnIndex]!;
    const isLatestTurn = turnIndex === latestTurnIndex;
    const isExternallyActiveTurn =
      isLatestTurn &&
      input.externallyActiveTurnId !== undefined &&
      input.externallyActiveTurnId === turn.id &&
      turn.completedAt == null;
    const isTerminalTurn = turn.status !== "inProgress" && !isExternallyActiveTurn;
    const createdAt = turnCreatedAt(
      turn.startedAt,
      input.fallbackStartedAtByTurnId?.get(turn.id),
      threadCreatedAt,
      turnIndex,
      previousTurnCreatedAt,
    );
    previousTurnCreatedAt = createdAt;
    const canonicalTurnId = TurnId.make(turn.id);
    events.push({
      eventId: eventId(input.canonicalThreadId, input.sessionId, turn.id, "turn:started"),
      provider: HERDR_DRIVER,
      providerInstanceId: input.instanceId,
      threadId: input.canonicalThreadId,
      turnId: canonicalTurnId,
      createdAt,
      type: "turn.started",
      payload: {},
      providerRefs: { providerTurnId: turn.id },
      raw: turnLifecycleRaw(turn, isTerminalTurn),
    });

    for (const item of turn.items) {
      const event = itemEvent({ ...input, turn, item, createdAt });
      if (event) events.push(event);
    }

    if (isTerminalTurn) {
      events.push({
        eventId: eventId(input.canonicalThreadId, input.sessionId, turn.id, "turn:completed"),
        provider: HERDR_DRIVER,
        providerInstanceId: input.instanceId,
        threadId: input.canonicalThreadId,
        turnId: canonicalTurnId,
        createdAt: turnCompletedAt(
          turn,
          createdAt,
          input.thread,
          turnIndex,
          input.fallbackCompletedAtByTurnId?.get(turn.id),
        ),
        type: "turn.completed",
        payload: {
          state: turnState(turn.status),
          ...(turn.error?.message ? { errorMessage: turn.error.message } : {}),
        },
        providerRefs: { providerTurnId: turn.id },
        raw: turnLifecycleRaw(turn, true),
      });
    }
  }
  return events;
}

export function runtimeEventFingerprint(event: ProviderRuntimeEvent): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

export function selectCodexTranscriptEventsForPublication(input: {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly durableFingerprints: ReadonlyMap<string, string | null>;
  readonly inFlight: ReadonlyMap<string, CodexTranscriptInFlightEvent>;
  readonly emittedAtMs: number;
  readonly retryAfterMs: number;
  readonly maxRetryAfterMs?: number;
  readonly maxRetryExponent?: number;
  readonly maxRetryEvents?: number;
  readonly eventIdPrefix?: string;
}): {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly inFlight: ReadonlyMap<string, CodexTranscriptInFlightEvent>;
} {
  const lifecycleByTurn = new Map<
    string,
    {
      started?: ProviderRuntimeEvent;
      completed?: ProviderRuntimeEvent;
    }
  >();
  for (const event of input.events) {
    if (
      event.turnId === undefined ||
      (event.type !== "turn.started" && event.type !== "turn.completed")
    ) {
      continue;
    }
    const turnId = String(event.turnId);
    const lifecycle = lifecycleByTurn.get(turnId) ?? {};
    if (event.type === "turn.started") lifecycle.started = event;
    else lifecycle.completed = event;
    lifecycleByTurn.set(turnId, lifecycle);
  }

  const selected: ProviderRuntimeEvent[] = [];
  const nextInFlight = new Map(input.inFlight);
  if (input.eventIdPrefix !== undefined) {
    const currentEventIds = new Set(input.events.map((event) => String(event.eventId)));
    for (const eventId of nextInFlight.keys()) {
      if (eventId.startsWith(input.eventIdPrefix) && !currentEventIds.has(eventId)) {
        nextInFlight.delete(eventId);
      }
    }
  }
  const handledEventIds = new Set<string>();
  const maxRetryAfterMs = input.maxRetryAfterMs ?? input.retryAfterMs;
  const maxRetryExponent = input.maxRetryExponent ?? Number.POSITIVE_INFINITY;
  let remainingRetryEvents = input.maxRetryEvents ?? Number.POSITIVE_INFINITY;
  const matchingPending = (event: ProviderRuntimeEvent, fingerprint: string) => {
    const pending = input.inFlight.get(event.eventId);
    return pending?.fingerprint === fingerprint ? pending : undefined;
  };
  const retryDelayMs = (pending: CodexTranscriptInFlightEvent) =>
    Math.min(maxRetryAfterMs, input.retryAfterMs * 2 ** pending.retryCount);
  const isRecentlyInFlight = (event: ProviderRuntimeEvent, fingerprint: string) => {
    const pending = matchingPending(event, fingerprint);
    return pending !== undefined && input.emittedAtMs - pending.emittedAtMs < retryDelayMs(pending);
  };
  const lifecycleDecisionByTurn = new Map<
    string,
    {
      readonly publish: boolean;
      readonly entries: ReadonlyMap<
        string,
        { readonly event: ProviderRuntimeEvent; readonly fingerprint: string }
      >;
    }
  >();
  for (const [turnId, lifecycle] of lifecycleByTurn) {
    if (!lifecycle.started || !lifecycle.completed) continue;
    const entries = [lifecycle.started, lifecycle.completed].map((event) => ({
      event,
      fingerprint: runtimeEventFingerprint(event),
    }));
    const changedEntries = entries.filter(
      ({ event, fingerprint }) => input.durableFingerprints.get(event.eventId) !== fingerprint,
    );
    const hasFreshEntry = changedEntries.some(
      ({ event, fingerprint }) => matchingPending(event, fingerprint) === undefined,
    );
    const retryableEntries = changedEntries.filter(({ event, fingerprint }) => {
      const pending = matchingPending(event, fingerprint);
      return pending !== undefined && !isRecentlyInFlight(event, fingerprint);
    });
    const retryCost = entries.length;
    const publish =
      changedEntries.length > 0 &&
      (hasFreshEntry || (retryableEntries.length > 0 && remainingRetryEvents >= retryCost));
    if (publish && !hasFreshEntry) remainingRetryEvents -= retryCost;
    if (changedEntries.length === 0) {
      for (const { event } of entries) nextInFlight.delete(event.eventId);
    }
    lifecycleDecisionByTurn.set(turnId, {
      publish,
      entries: new Map(entries.map((entry) => [String(entry.event.eventId), entry])),
    });
  }

  for (const event of input.events) {
    if (handledEventIds.has(event.eventId)) continue;

    const lifecycleDecision =
      event.turnId === undefined ||
      (event.type !== "turn.started" && event.type !== "turn.completed")
        ? undefined
        : lifecycleDecisionByTurn.get(String(event.turnId));
    if (lifecycleDecision !== undefined) {
      handledEventIds.add(event.eventId);
      const entry = lifecycleDecision.entries.get(String(event.eventId));
      if (lifecycleDecision.publish && entry) {
        selected.push(event);
        const pending = matchingPending(event, entry.fingerprint);
        nextInFlight.set(event.eventId, {
          fingerprint: entry.fingerprint,
          emittedAtMs: input.emittedAtMs,
          retryCount: pending ? Math.min(maxRetryExponent, pending.retryCount + 1) : 0,
        });
      }
      continue;
    }

    handledEventIds.add(event.eventId);
    const fingerprint = runtimeEventFingerprint(event);
    if (input.durableFingerprints.get(event.eventId) === fingerprint) {
      nextInFlight.delete(event.eventId);
      continue;
    }
    const pending = matchingPending(event, fingerprint);
    if (pending !== undefined) {
      if (isRecentlyInFlight(event, fingerprint) || remainingRetryEvents < 1) {
        continue;
      }
      remainingRetryEvents -= 1;
    }
    selected.push(event);
    nextInFlight.set(event.eventId, {
      fingerprint,
      emittedAtMs: input.emittedAtMs,
      retryCount: pending ? Math.min(maxRetryExponent, pending.retryCount + 1) : 0,
    });
  }

  return { events: selected, inFlight: nextInFlight };
}
