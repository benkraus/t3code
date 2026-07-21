import {
  EventId,
  HerdrSettings,
  ProviderDriverKind,
  TextGenerationError,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexErrors from "effect-codex-app-server/errors";
import * as NodeCrypto from "node:crypto";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  makeCodexThreadReader,
  type CodexThreadReader,
  type CodexThreadSnapshot,
} from "../../herdr/CodexThreadReader.ts";
import {
  advanceCodexTranscriptStabilization,
  classifyCodexColdStartTurn,
  codexUserMessageText,
  codexThreadRuntimeEvents,
  codexTranscriptPanePriority,
  codexTranscriptPaneSignature,
  resolveCodexExternallyActiveTurnId,
  runtimeEventFingerprint,
  selectCodexTranscriptEventsForPublication,
  staleCodexCompletionReceiptEventId,
  shouldRefreshCodexTranscript,
  type CodexColdStartCandidate,
  type CodexTranscriptStabilizationCandidate,
} from "../../herdr/codexTranscript.ts";
import * as HerdrEnvironmentRegistry from "../../herdr/HerdrEnvironmentRegistry.ts";
import { herdrThreadId, splitCommand } from "../../herdr/identity.ts";
import type { HerdrWirePane } from "../../herdr/HerdrSocketClient.ts";
import {
  HerdrCodexThreadBindingRepository,
  type HerdrCodexThreadBinding,
} from "../../persistence/Services/HerdrCodexThreadBindings.ts";
import {
  ProviderRuntimeEventReceiptRepository,
  type ProviderRuntimeEventReceipt,
} from "../../persistence/Services/ProviderRuntimeEventReceipts.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { isRecoverableThreadResumeError } from "../Layers/CodexSessionRuntime.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const DRIVER_KIND = ProviderDriverKind.make("herdr");
const MODEL_SLUG = "herdr-managed";
const TRANSCRIPT_IN_FLIGHT_RETRY_MS = 5_000;
const TRANSCRIPT_IN_FLIGHT_MAX_RETRY_MS = 60_000;
const TRANSCRIPT_IN_FLIGHT_MAX_RETRY_EXPONENT = 6;
const TRANSCRIPT_IN_FLIGHT_MAX_RETRY_EVENTS = 16;
const decodeSettings = Schema.decodeSync(HerdrSettings);

interface TranscriptInFlightEvent {
  readonly fingerprint: string;
  readonly emittedAtMs: number;
  readonly retryCount: number;
}

interface TranscriptUserMessageMapping {
  readonly signature: string;
  readonly createdAtByItemId: ReadonlyMap<string, string>;
}

function hasTranscriptInFlightForPrefix(
  inFlight: ReadonlyMap<string, TranscriptInFlightEvent>,
  eventIdPrefix: string,
): boolean {
  return Array.from(inFlight.keys()).some((eventId) => eventId.startsWith(eventIdPrefix));
}

function hasExpiredTranscriptInFlightForPrefix(
  inFlight: ReadonlyMap<string, TranscriptInFlightEvent>,
  eventIdPrefix: string,
  nowMs: number,
): boolean {
  return Array.from(inFlight.entries()).some(
    ([eventId, pending]) =>
      eventId.startsWith(eventIdPrefix) &&
      nowMs - pending.emittedAtMs >=
        Math.min(
          TRANSCRIPT_IN_FLIGHT_MAX_RETRY_MS,
          TRANSCRIPT_IN_FLIGHT_RETRY_MS * 2 ** pending.retryCount,
        ),
  );
}

function reconcileTranscriptInFlight(
  inFlight: ReadonlyMap<string, TranscriptInFlightEvent>,
  durableFingerprints: ReadonlyMap<string, string | null>,
  eventIdPrefix: string,
): ReadonlyMap<string, TranscriptInFlightEvent> {
  const next = new Map(inFlight);
  for (const [eventId, pending] of inFlight) {
    if (
      eventId.startsWith(eventIdPrefix) &&
      durableFingerprints.get(eventId) === pending.fingerprint
    ) {
      next.delete(eventId);
    }
  }
  return next;
}

export function resolveHerdrTranscriptStartedAtFallback(input: {
  readonly projectedStartedAt: string | null | undefined;
  readonly cachedStartedAt: string | undefined;
  readonly observedAt: string;
}): string {
  return input.projectedStartedAt ?? input.cachedStartedAt ?? input.observedAt;
}

export function retainHerdrThreadState<K extends string, T>(
  current: ReadonlyMap<K, T>,
  retainedThreadIds: ReadonlySet<string>,
): ReadonlyMap<K, T> {
  if (current.size === 0 || Array.from(current.keys()).every((key) => retainedThreadIds.has(key))) {
    return current;
  }
  return new Map(Array.from(current).filter(([threadId]) => retainedThreadIds.has(threadId)));
}

export function retainHerdrTranscriptInFlightState<T>(
  current: ReadonlyMap<string, T>,
  retainedThreadIds: ReadonlySet<string>,
): ReadonlyMap<string, T> {
  if (current.size === 0) return current;
  const retainedPrefixes = Array.from(retainedThreadIds, (threadId) => `herdr-codex:${threadId}:`);
  const next = new Map(
    Array.from(current).filter(([eventId]) =>
      retainedPrefixes.some((prefix) => eventId.startsWith(prefix)),
    ),
  );
  return next.size === current.size ? current : next;
}

function jsonSha256(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function codexTranscriptSnapshotSignature(input: {
  readonly pane: HerdrWirePane;
  readonly thread: CodexThreadSnapshot;
  readonly userMessageCreatedAtByItemId: ReadonlyMap<string, string>;
}): string {
  return jsonSha256([
    input.pane.agent_status,
    input.pane.revision,
    input.pane.agent_session,
    input.thread,
    Array.from(input.userMessageCreatedAtByItemId),
  ]);
}

export function codexLatestTurnSnapshotSignature(
  turn: CodexThreadSnapshot["turns"][number],
): string {
  return jsonSha256(turn);
}

export function codexTranscriptUserItemsSignature(thread: CodexThreadSnapshot): string {
  return jsonSha256(
    thread.turns.flatMap((turn) =>
      turn.items.flatMap((item) =>
        item.type === "userMessage"
          ? [[turn.id, turn.startedAt, item.id, codexUserMessageText(item)] as const]
          : [],
      ),
    ),
  );
}

function codexUserMessageProjectionText(
  item: Extract<CodexThreadSnapshot["turns"][number]["items"][number], { type: "userMessage" }>,
): string {
  return item.content
    .flatMap((content) => {
      switch (content.type) {
        case "text":
          return [content.text];
        case "skill":
          return [`$${content.name}`];
        case "mention":
          return [`@${content.name}`];
        case "image":
        case "localImage":
          return [];
      }
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export type HerdrDriverEnv =
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | HerdrCodexThreadBindingRepository
  | ProviderRuntimeEventReceiptRepository
  | ProjectionThreadMessageRepository
  | ProjectionTurnRepository;

export function mapCodexUserMessageCreatedAt(input: {
  readonly thread: CodexThreadSnapshot;
  readonly projectedUserMessages: ReadonlyArray<{
    readonly messageId?: string;
    readonly createdAt: string;
    readonly text: string;
  }>;
  readonly projectedTurnStartedAtById?: ReadonlyMap<string, string>;
  readonly projectedTurnPendingMessageIdById?: ReadonlyMap<string, string | null>;
}): ReadonlyMap<string, string> {
  const normalizePrompt = (value: string) => value.trim().replace(/\s+/g, " ");
  const projectedUserMessages = input.projectedUserMessages
    .filter((message) => !message.messageId?.startsWith("user:herdr-codex:"))
    .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const transcriptUserItems = input.thread.turns.flatMap((turn) =>
    turn.items
      .filter((item) => item.type === "userMessage")
      .map((item, userIndexWithinTurn) => ({
        item,
        preferLatestCandidate: userIndexWithinTurn === 0,
        preferredMessageId:
          userIndexWithinTurn === 0
            ? (input.projectedTurnPendingMessageIdById?.get(turn.id) ?? undefined)
            : undefined,
        startedAtMs:
          userIndexWithinTurn > 0
            ? Number.NaN
            : turn.startedAt == null
              ? Date.parse(input.projectedTurnStartedAtById?.get(turn.id) ?? "")
              : turn.startedAt * 1_000,
      })),
  );
  const transcriptTexts = transcriptUserItems.map((entry) =>
    normalizePrompt(codexUserMessageProjectionText(entry.item)),
  );
  const projectedTexts = projectedUserMessages.map((message) => normalizePrompt(message.text));
  const projectedIndexByMessageId = new Map(
    projectedUserMessages.flatMap((message, index) =>
      message.messageId === undefined ? [] : [[message.messageId, index] as const],
    ),
  );
  const projectedIndicesByText = new Map<string, number[]>();
  for (let index = 0; index < projectedTexts.length; index += 1) {
    const text = projectedTexts[index];
    if (text === undefined) continue;
    const indices = projectedIndicesByText.get(text) ?? [];
    indices.push(index);
    projectedIndicesByText.set(text, indices);
  }

  const latestSafeProjectedIndex = new Int32Array(transcriptUserItems.length);
  latestSafeProjectedIndex.fill(-1);
  let reverseCursor = projectedUserMessages.length - 1;
  for (
    let transcriptIndex = transcriptUserItems.length - 1;
    transcriptIndex >= 0;
    transcriptIndex -= 1
  ) {
    const candidates = projectedIndicesByText.get(transcriptTexts[transcriptIndex]!);
    if (!candidates) continue;
    let low = 0;
    let high = candidates.length - 1;
    let match = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = candidates[middle]!;
      if (candidate <= reverseCursor) {
        match = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (match < 0) continue;
    latestSafeProjectedIndex[transcriptIndex] = match;
    reverseCursor = match - 1;
  }

  const result = new Map<string, string>();
  let projectedCursor = 0;
  for (
    let transcriptIndex = 0;
    transcriptIndex < transcriptUserItems.length;
    transcriptIndex += 1
  ) {
    const latestSafeIndex = latestSafeProjectedIndex[transcriptIndex]!;
    if (latestSafeIndex < projectedCursor) continue;
    const candidates = projectedIndicesByText.get(transcriptTexts[transcriptIndex]!);
    if (!candidates) continue;
    const transcriptEntry = transcriptUserItems[transcriptIndex]!;
    const preferredIndex =
      transcriptEntry.preferredMessageId === undefined
        ? undefined
        : projectedIndexByMessageId.get(transcriptEntry.preferredMessageId);
    if (
      preferredIndex !== undefined &&
      preferredIndex >= projectedCursor &&
      preferredIndex <= latestSafeIndex &&
      projectedTexts[preferredIndex] === transcriptTexts[transcriptIndex]
    ) {
      result.set(transcriptEntry.item.id, projectedUserMessages[preferredIndex]!.createdAt);
      projectedCursor = preferredIndex + 1;
      continue;
    }
    let bestIndex: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidateIndex of candidates) {
      if (candidateIndex < projectedCursor) continue;
      if (candidateIndex > latestSafeIndex) break;
      const projectedTime = Date.parse(projectedUserMessages[candidateIndex]!.createdAt);
      const distance =
        Number.isFinite(transcriptEntry.startedAtMs) && Number.isFinite(projectedTime)
          ? Math.abs(projectedTime - transcriptEntry.startedAtMs)
          : Number.POSITIVE_INFINITY;
      if (
        bestIndex === undefined ||
        distance < bestDistance ||
        (distance === bestDistance &&
          transcriptEntry.preferLatestCandidate &&
          candidateIndex > bestIndex)
      ) {
        bestIndex = candidateIndex;
        bestDistance = distance;
      }
    }
    if (bestIndex === undefined) continue;
    result.set(transcriptEntry.item.id, projectedUserMessages[bestIndex]!.createdAt);
    projectedCursor = bestIndex + 1;
  }
  return result;
}

export function codexTranscriptThreadId(thread: CodexThreadSnapshot): string {
  return thread.id;
}

export function codexTranscriptSessionId(thread: CodexThreadSnapshot): string {
  return thread.sessionId;
}

export function resolveCodexTranscriptEventNamespace(input: {
  readonly binding: HerdrCodexThreadBinding | undefined;
  readonly reportedSessionId: string;
  readonly recoveredEventNamespaceId?: string;
  readonly preserveBoundNamespace?: boolean;
}): string {
  if (input.binding !== undefined && input.preserveBoundNamespace === true) {
    return input.binding.eventNamespaceId;
  }
  if (input.binding === undefined && input.recoveredEventNamespaceId !== undefined) {
    return input.recoveredEventNamespaceId;
  }
  return input.reportedSessionId;
}

export function recoverCodexTranscriptEventNamespace(input: {
  readonly threadId: ThreadId;
  readonly thread: CodexThreadSnapshot;
  readonly receipts: ReadonlyArray<ProviderRuntimeEventReceipt>;
  readonly reportedSessionId: string;
}): string | undefined {
  const matchesByNamespace = codexTranscriptNamespaceMatchCounts(input);
  return Array.from(matchesByNamespace).sort(
    ([leftNamespace, leftCount], [rightNamespace, rightCount]) =>
      rightCount - leftCount ||
      Number(rightNamespace === input.reportedSessionId) -
        Number(leftNamespace === input.reportedSessionId) ||
      leftNamespace.localeCompare(rightNamespace),
  )[0]?.[0];
}

function codexTranscriptNamespaceMatchCounts(input: {
  readonly threadId: ThreadId;
  readonly thread: CodexThreadSnapshot;
  readonly receipts: ReadonlyArray<ProviderRuntimeEventReceipt>;
}): ReadonlyMap<string, number> {
  const eventIdPrefix = `herdr-codex:${input.threadId}:`;
  const currentSuffixes = new Set<string>();
  for (const turn of input.thread.turns) {
    currentSuffixes.add(`${turn.id}:turn:started`);
    currentSuffixes.add(`${turn.id}:turn:completed`);
    for (const item of turn.items) {
      currentSuffixes.add(`${turn.id}:item:${item.id}`);
    }
  }
  const matchesByNamespace = new Map<string, number>();
  for (const receipt of input.receipts) {
    const eventId = String(receipt.eventId);
    if (!eventId.startsWith(eventIdPrefix)) continue;
    const scopedId = eventId.slice(eventIdPrefix.length);
    const separatorIndex = scopedId.indexOf(":");
    if (separatorIndex <= 0) continue;
    const namespace = scopedId.slice(0, separatorIndex);
    const suffix = scopedId.slice(separatorIndex + 1);
    if (!currentSuffixes.has(suffix)) continue;
    matchesByNamespace.set(namespace, (matchesByNamespace.get(namespace) ?? 0) + 1);
  }
  return matchesByNamespace;
}

export function codexTranscriptReceiptNamespaces(input: {
  readonly threadId: ThreadId;
  readonly receipts: ReadonlyArray<ProviderRuntimeEventReceipt>;
}): ReadonlyArray<string> {
  const eventIdPrefix = `herdr-codex:${input.threadId}:`;
  const namespaces = new Set<string>();
  for (const receipt of input.receipts) {
    const eventId = String(receipt.eventId);
    if (!eventId.startsWith(eventIdPrefix)) continue;
    const scopedId = eventId.slice(eventIdPrefix.length);
    const separatorIndex = scopedId.indexOf(":");
    if (separatorIndex > 0) namespaces.add(scopedId.slice(0, separatorIndex));
  }
  return Array.from(namespaces).sort();
}

export function selectCodexBootstrapThread(input: {
  readonly threadId: ThreadId;
  readonly receipts: ReadonlyArray<ProviderRuntimeEventReceipt>;
  readonly candidates: ReadonlyArray<{
    readonly namespaceId: string;
    readonly thread: CodexThreadSnapshot;
  }>;
}): CodexThreadSnapshot | undefined {
  return input.candidates
    .map((candidate) => ({
      ...candidate,
      matchingReceiptCount:
        codexTranscriptNamespaceMatchCounts({
          threadId: input.threadId,
          thread: candidate.thread,
          receipts: input.receipts,
        }).get(candidate.namespaceId) ?? 0,
    }))
    .filter((candidate) => candidate.matchingReceiptCount > 0)
    .sort(
      (left, right) =>
        right.matchingReceiptCount - left.matchingReceiptCount ||
        right.thread.updatedAt - left.thread.updatedAt ||
        left.namespaceId.localeCompare(right.namespaceId),
    )[0]?.thread;
}

function sameCodexThreadBindingIdentity(
  binding: HerdrCodexThreadBinding,
  identity: Omit<HerdrCodexThreadBinding, "updatedAt">,
): boolean {
  return (
    binding.threadId === identity.threadId &&
    binding.codexThreadId === identity.codexThreadId &&
    binding.codexSessionId === identity.codexSessionId &&
    binding.reportedSessionId === identity.reportedSessionId &&
    binding.eventNamespaceId === identity.eventNamespaceId
  );
}

export function selectCodexThreadForPane(
  recovered: CodexThreadSnapshot,
  reported: CodexThreadSnapshot,
): CodexThreadSnapshot {
  return recovered.id === reported.id ? recovered : reported;
}

export function shouldProbeReportedCodexThread(input: {
  readonly boundThreadId: string;
  readonly recoveredThreadId: string;
  readonly reportedSessionId: string;
}): boolean {
  return (
    input.boundThreadId !== input.reportedSessionId &&
    input.recoveredThreadId === input.boundThreadId
  );
}

export function prioritizeCodexReasoningBackfill(input: {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly durableFingerprints: ReadonlyMap<string, string | null>;
  readonly latestTurnId: TurnId | undefined;
}): ReadonlyArray<ProviderRuntimeEvent> {
  if (input.latestTurnId === undefined) return input.events;
  const prioritized: ProviderRuntimeEvent[] = [];
  const remaining: ProviderRuntimeEvent[] = [];
  for (const event of input.events) {
    const eventId = String(event.eventId);
    const isChangedLatestReasoning =
      event.type === "item.completed" &&
      event.payload.itemType === "reasoning" &&
      event.turnId === input.latestTurnId &&
      input.durableFingerprints.has(eventId) &&
      input.durableFingerprints.get(eventId) !== runtimeEventFingerprint(event);
    (isChangedLatestReasoning ? prioritized : remaining).push(event);
  }
  return [...prioritized, ...remaining];
}

function codexSessionId(pane: HerdrWirePane): string | null {
  const session = pane.agent_session;
  if (
    pane.agent !== "codex" ||
    session?.agent !== "codex" ||
    session.kind !== "id" ||
    !session.value.trim()
  ) {
    return null;
  }
  return session.value.trim();
}

function toProviderStatus(status: string): ProviderSession["status"] {
  switch (status) {
    case "working":
    case "blocked":
      return "running";
    case "idle":
    case "done":
      return "ready";
    default:
      return "connecting";
  }
}

function textGenerationUnsupported(operation: string) {
  return Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "HerdR delegates text generation to the agent process and does not expose it directly.",
    }),
  );
}

const herdrTextGeneration: TextGeneration.TextGeneration["Service"] =
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () => textGenerationUnsupported("generateCommitMessage"),
    generatePrContent: () => textGenerationUnsupported("generatePrContent"),
    generateBranchName: () => textGenerationUnsupported("generateBranchName"),
    generateThreadTitle: () => textGenerationUnsupported("generateThreadTitle"),
  });

export const HerdrDriver: ProviderDriver<HerdrSettings, HerdrDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "HerdR",
    supportsMultipleInstances: true,
  },
  configSchema: HerdrSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const environment = yield* HerdrEnvironmentRegistry.registerEnvironment(instanceId, config);
      const crypto = yield* Crypto.Crypto;
      const codexThreadBindings = yield* HerdrCodexThreadBindingRepository;
      const runtimeEventReceipts = yield* ProviderRuntimeEventReceiptRepository;
      const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
      const projectionTurns = yield* ProjectionTurnRepository;
      const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const runtimeEventsReady = yield* Deferred.make<void>();
      const activeTurns = yield* Ref.make<ReadonlyMap<ThreadId, TurnId>>(new Map());
      const paneSignatures = yield* Ref.make<ReadonlyMap<ThreadId, string>>(new Map());
      const paneAttemptSignatures = yield* Ref.make<ReadonlyMap<ThreadId, string>>(new Map());
      const transcriptRefreshAtMs = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());
      const transcriptStabilizationCandidates = yield* Ref.make<
        ReadonlyMap<ThreadId, CodexTranscriptStabilizationCandidate>
      >(new Map());
      const coldStartCandidates = yield* Ref.make<ReadonlyMap<ThreadId, CodexColdStartCandidate>>(
        new Map(),
      );
      const latestTranscriptTurnIds = yield* Ref.make<ReadonlyMap<ThreadId, TurnId>>(new Map());
      const transcriptFallbackStartedAt = yield* Ref.make<
        ReadonlyMap<ThreadId, ReadonlyMap<string, string>>
      >(new Map());
      const transcriptFallbackCompletedAt = yield* Ref.make<
        ReadonlyMap<ThreadId, ReadonlyMap<string, string>>
      >(new Map());
      const transcriptInFlight = yield* Ref.make<ReadonlyMap<string, TranscriptInFlightEvent>>(
        new Map(),
      );
      const durableFingerprintCache = yield* Ref.make<
        ReadonlyMap<ThreadId, ReadonlyMap<string, string | null>>
      >(new Map());
      const transcriptSnapshotSignatures = yield* Ref.make<ReadonlyMap<ThreadId, string>>(
        new Map(),
      );
      const transcriptBindings = yield* Ref.make<ReadonlyMap<ThreadId, HerdrCodexThreadBinding>>(
        new Map(),
      );
      const transcriptUserMessageMappings = yield* Ref.make<
        ReadonlyMap<ThreadId, TranscriptUserMessageMapping>
      >(new Map());
      const transcriptPublishSemaphore = yield* Semaphore.make(1);
      const transcriptThreadLocks = yield* SynchronizedRef.make(
        new Map<string, Semaphore.Semaphore>(),
      );
      const command = splitCommand(config.agentCommand);
      const codexBinaryPath =
        (config.agentName.trim().toLowerCase() === "codex" ||
          command[0]?.toLowerCase().includes("codex")) &&
        command[0]
          ? command[0]
          : null;
      const codexReader: CodexThreadReader | null = codexBinaryPath
        ? yield* makeCodexThreadReader({
            binaryPath: codexBinaryPath,
            cwd: process.cwd(),
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("HerdR Codex transcript reader is unavailable", {
                instanceId,
                detail: cause.message,
              }).pipe(Effect.as(null)),
            ),
          )
        : null;
      const randomUUIDv4 = crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: DRIVER_KIND,
              method: "crypto/randomUUIDv4",
              detail: "Failed to generate HerdR runtime identifier.",
              cause,
            }),
        ),
      );

      const publish = (event: ProviderRuntimeEvent) =>
        PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

      const getTranscriptThreadSemaphore = (threadId: ThreadId) =>
        SynchronizedRef.modifyEffect(transcriptThreadLocks, (current) => {
          const existing = Option.fromNullishOr(current.get(threadId));
          return Option.match(existing, {
            onNone: () =>
              Semaphore.make(1).pipe(
                Effect.map((semaphore) => {
                  const next = new Map(current);
                  next.set(threadId, semaphore);
                  return [semaphore, next] as const;
                }),
              ),
            onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
          });
        });

      const withTranscriptThreadLock = <A, E, R>(
        threadId: ThreadId,
        effect: Effect.Effect<A, E, R>,
      ) =>
        Effect.flatMap(getTranscriptThreadSemaphore(threadId), (semaphore) =>
          semaphore.withPermit(effect),
        );

      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      const readCodexThreadOptional = (
        candidateId: string,
      ): Effect.Effect<Option.Option<CodexThreadSnapshot>, CodexErrors.CodexAppServerError> =>
        codexReader!.readThread(candidateId).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => isRecoverableThreadResumeError(error),
            () => Effect.succeed(Option.none<CodexThreadSnapshot>()),
          ),
        );

      const readUnboundCodexThread = Effect.fn("HerdrDriver.readUnboundCodexThread")(function* (
        reportedSessionId: string,
        threadId: ThreadId,
        receipts: ReadonlyArray<ProviderRuntimeEventReceipt>,
      ): Effect.fn.Return<CodexThreadSnapshot, CodexErrors.CodexAppServerError> {
        const reported = yield* readCodexThreadOptional(reportedSessionId);
        if (Option.isSome(reported)) return reported.value;
        const candidateNamespaceIds = codexTranscriptReceiptNamespaces({
          threadId,
          receipts,
        }).filter((candidateId) => candidateId !== reportedSessionId);
        const attemptedCandidates = yield* Effect.forEach(
          candidateNamespaceIds,
          (namespaceId) =>
            readCodexThreadOptional(namespaceId).pipe(
              Effect.map(
                Option.map((thread) => ({
                  namespaceId,
                  thread,
                })),
              ),
            ),
          { concurrency: 1 },
        );
        const selected = selectCodexBootstrapThread({
          threadId,
          receipts,
          candidates: attemptedCandidates.flatMap((candidate) => Option.toArray(candidate)),
        });
        if (selected !== undefined) return selected;
        return yield* codexReader!.readThread(reportedSessionId);
      });

      const readCodexThreadForPane = Effect.fn("HerdrDriver.readCodexThreadForPane")(function* (
        pane: HerdrWirePane,
        threadId: ThreadId,
      ) {
        if (!codexReader) return null;
        const reportedSessionId = codexSessionId(pane);
        if (!reportedSessionId) return null;
        const cachedBinding = (yield* Ref.get(transcriptBindings)).get(threadId);
        const persistedBinding =
          cachedBinding ??
          (yield* codexThreadBindings
            .getByThreadId({ threadId })
            .pipe(Effect.map(Option.getOrUndefined)));
        if (cachedBinding === undefined && persistedBinding !== undefined) {
          yield* Ref.update(transcriptBindings, (current) => {
            const next = new Map(current);
            next.set(threadId, persistedBinding);
            return next;
          });
        }
        const legacyReceipts =
          persistedBinding === undefined
            ? yield* runtimeEventReceipts.listByEventIdPrefix({
                provider: DRIVER_KIND,
                eventIdPrefix: `herdr-codex:${threadId}:`,
              })
            : [];
        const boundThreadId = persistedBinding?.codexThreadId;
        const thread = yield* Effect.gen(function* () {
          if (boundThreadId === undefined) {
            return yield* readUnboundCodexThread(reportedSessionId, threadId, legacyReceipts);
          }
          if (boundThreadId === reportedSessionId) {
            return yield* codexReader.readThread(reportedSessionId);
          }
          const recovered = yield* codexReader.readThread(boundThreadId, reportedSessionId);
          if (
            !shouldProbeReportedCodexThread({
              boundThreadId,
              recoveredThreadId: recovered.id,
              reportedSessionId,
            })
          ) {
            return recovered;
          }
          const reported = yield* readCodexThreadOptional(reportedSessionId);
          return Option.match(reported, {
            onNone: () => recovered,
            onSome: (candidate) => selectCodexThreadForPane(recovered, candidate),
          });
        });
        const recoveredEventNamespaceId =
          persistedBinding === undefined
            ? recoverCodexTranscriptEventNamespace({
                threadId,
                thread,
                receipts: legacyReceipts,
                reportedSessionId,
              })
            : undefined;
        const preserveBoundNamespace =
          persistedBinding === undefined
            ? false
            : thread.id === persistedBinding.codexThreadId
              ? true
              : yield* runtimeEventReceipts
                  .listByEventIdPrefix({
                    provider: DRIVER_KIND,
                    eventIdPrefix: `herdr-codex:${threadId}:${persistedBinding.eventNamespaceId}:`,
                  })
                  .pipe(
                    Effect.map(
                      (receipts) =>
                        receipts.length === 0 ||
                        (codexTranscriptNamespaceMatchCounts({
                          threadId,
                          thread,
                          receipts,
                        }).get(persistedBinding.eventNamespaceId) ?? 0) > 0,
                    ),
                  );
        const bindingIdentity = {
          threadId,
          codexThreadId: codexTranscriptThreadId(thread),
          codexSessionId: codexTranscriptSessionId(thread),
          reportedSessionId,
          eventNamespaceId: resolveCodexTranscriptEventNamespace({
            binding: persistedBinding,
            reportedSessionId,
            preserveBoundNamespace,
            ...(recoveredEventNamespaceId !== undefined ? { recoveredEventNamespaceId } : {}),
          }),
        };
        const binding =
          persistedBinding !== undefined &&
          sameCodexThreadBindingIdentity(persistedBinding, bindingIdentity)
            ? persistedBinding
            : {
                ...bindingIdentity,
                updatedAt: yield* nowIso,
              };
        if (binding !== persistedBinding) {
          yield* codexThreadBindings.upsert(binding);
          yield* Ref.update(transcriptBindings, (current) => {
            const next = new Map(current);
            next.set(threadId, binding);
            return next;
          });
        }
        return { thread, eventNamespaceId: binding.eventNamespaceId };
      });

      const publishCodexThread = Effect.fn("HerdrDriver.publishCodexThread")(function* (
        pane: HerdrWirePane,
        resolved: {
          readonly thread: CodexThreadSnapshot;
          readonly eventNamespaceId: string;
        },
        forcedActiveTurnId?: TurnId,
      ) {
        const { thread, eventNamespaceId: sessionId } = resolved;
        const threadId = herdrThreadId(instanceId, pane);
        const externallyActive = pane.agent_status === "working" || pane.agent_status === "blocked";
        const eventIdPrefix = `herdr-codex:${threadId}:${sessionId}:`;
        const cachedDurableFingerprints = (yield* Ref.get(durableFingerprintCache)).get(threadId);
        const hasPendingBeforeRefresh = hasTranscriptInFlightForPrefix(
          yield* Ref.get(transcriptInFlight),
          eventIdPrefix,
        );
        const durableReceiptSnapshot =
          cachedDurableFingerprints === undefined || hasPendingBeforeRefresh
            ? yield* runtimeEventReceipts
                .listByEventIdPrefix({ provider: DRIVER_KIND, eventIdPrefix })
                .pipe(
                  Effect.map((receipts) => ({
                    available: true as const,
                    loaded: true as const,
                    fingerprints: new Map<string, string | null>(
                      receipts.map((receipt) => [String(receipt.eventId), receipt.fingerprint]),
                    ),
                  })),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("HerdR runtime receipts are unavailable", {
                      instanceId,
                      threadId,
                      detail: Cause.pretty(cause),
                    }).pipe(
                      Effect.as({
                        available: cachedDurableFingerprints !== undefined,
                        loaded: false as const,
                        fingerprints: cachedDurableFingerprints ?? new Map<string, string | null>(),
                      }),
                    ),
                  ),
                )
            : {
                available: true as const,
                loaded: false as const,
                fingerprints: cachedDurableFingerprints,
              };
        let durableFingerprints = durableReceiptSnapshot.fingerprints;
        const previousLatestTurnId = (yield* Ref.get(latestTranscriptTurnIds)).get(threadId);
        const activeTurnId = (yield* Ref.get(activeTurns)).get(threadId);
        const latestTurn = thread.turns.at(-1);
        const needsColdExternalClassification =
          externallyActive &&
          previousLatestTurnId === undefined &&
          activeTurnId === undefined &&
          latestTurn !== undefined &&
          latestTurn.completedAt == null &&
          latestTurn.status !== "inProgress";
        if (needsColdExternalClassification && !durableReceiptSnapshot.available) {
          return null;
        }
        const projectedTurnsSnapshot = yield* projectionTurns.listByThreadId({ threadId }).pipe(
          Effect.map((value) => ({ available: true as const, value })),
          Effect.catchCause((cause) =>
            Effect.logWarning("HerdR projected turn state is unavailable", {
              instanceId,
              threadId,
              detail: Cause.pretty(cause),
            }).pipe(
              Effect.as({
                available: false as const,
                value: [],
              }),
            ),
          ),
        );
        if (!projectedTurnsSnapshot.available) {
          return null;
        }
        const projectedTurnsById = new Map(
          projectedTurnsSnapshot.value.flatMap((turn) =>
            turn.turnId === null ? [] : [[String(turn.turnId), turn] as const],
          ),
        );
        const projectedLatestTurn = Option.fromNullishOr(
          latestTurn ? projectedTurnsById.get(latestTurn.id) : undefined,
        );
        const staleCompletionEventId = staleCodexCompletionReceiptEventId({
          eventIdPrefix,
          latestTurnId: latestTurn ? TurnId.make(latestTurn.id) : undefined,
          projectedLatestTurnState: Option.getOrUndefined(projectedLatestTurn)?.state,
          durableFingerprints,
        });
        if (staleCompletionEventId !== undefined) {
          const invalidated = yield* runtimeEventReceipts
            .deleteByEventId({
              provider: DRIVER_KIND,
              eventId: EventId.make(staleCompletionEventId),
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("HerdR stale completion receipt could not be invalidated", {
                  instanceId,
                  threadId,
                  eventId: staleCompletionEventId,
                  detail: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
              ),
            );
          if (!invalidated) return null;
          const nextDurableFingerprints = new Map(durableFingerprints);
          nextDurableFingerprints.delete(staleCompletionEventId);
          durableFingerprints = nextDurableFingerprints;
        }
        if (durableReceiptSnapshot.loaded || staleCompletionEventId !== undefined) {
          yield* Ref.update(durableFingerprintCache, (current) => {
            const next = new Map(current);
            next.set(threadId, durableFingerprints);
            return next;
          });
        }
        const latestTurnHasDurableCompletion =
          latestTurn !== undefined &&
          durableFingerprints.has(`${eventIdPrefix}${latestTurn.id}:turn:completed`);
        const coldStartClassification =
          needsColdExternalClassification && latestTurn !== undefined
            ? classifyCodexColdStartTurn({
                candidate: (yield* Ref.get(coldStartCandidates)).get(threadId),
                turnId: TurnId.make(latestTurn.id),
                snapshotSignature: codexLatestTurnSnapshotSignature(latestTurn),
                projectedTerminal: Option.match(projectedLatestTurn, {
                  onNone: () => false,
                  onSome: (turn) => turn.state !== "running" && turn.state !== "pending",
                }),
                hasDurableCompletion: latestTurnHasDurableCompletion,
              })
            : { candidate: undefined, defer: false };
        yield* Ref.update(coldStartCandidates, (current) => {
          const next = new Map(current);
          if (coldStartClassification.candidate) {
            next.set(threadId, coldStartClassification.candidate);
          } else {
            next.delete(threadId);
          }
          return next;
        });
        if (coldStartClassification.defer) return null;
        const externallyActiveTurnId = resolveCodexExternallyActiveTurnId({
          thread,
          externallyActive,
          latestTurnHasDurableCompletion,
          ...(previousLatestTurnId !== undefined ? { previousLatestTurnId } : {}),
          ...(activeTurnId !== undefined ? { activeTurnId } : {}),
          ...(forcedActiveTurnId !== undefined ? { forcedActiveTurnId } : {}),
        });
        const userItemsSignature = codexTranscriptUserItemsSignature(thread);
        const cachedUserMessageMapping = (yield* Ref.get(transcriptUserMessageMappings)).get(
          threadId,
        );
        const userMessageMapping = yield* Effect.gen(function* () {
          const hasUserItems = thread.turns.some((turn) =>
            turn.items.some((item) => item.type === "userMessage"),
          );
          const mappingSignature = hasUserItems
            ? yield* projectionThreadMessages.getUserTimestampRevisionByThreadId({ threadId }).pipe(
                Effect.map((revision) =>
                  jsonSha256([
                    userItemsSignature,
                    revision,
                    Array.from(projectedTurnsById, ([turnId, turn]) => [
                      turnId,
                      turn.startedAt ?? turn.requestedAt,
                      turn.pendingMessageId,
                    ]),
                  ]),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("HerdR projected user message revision is unavailable", {
                    instanceId,
                    threadId,
                    detail: Cause.pretty(cause),
                  }).pipe(Effect.as(null)),
                ),
              )
            : userItemsSignature;
          if (mappingSignature === null) return null;
          if (cachedUserMessageMapping?.signature === mappingSignature) {
            return cachedUserMessageMapping;
          }
          if (!hasUserItems) {
            return {
              signature: mappingSignature,
              createdAtByItemId: new Map<string, string>(),
            };
          }
          const projectedUserMessagesSnapshot = yield* projectionThreadMessages
            .listUserTimestampsByThreadId({ threadId })
            .pipe(
              Effect.map((messages) => ({
                available: true as const,
                value: messages,
              })),
              Effect.catchCause((cause) =>
                Effect.logWarning("HerdR projected user messages are unavailable", {
                  instanceId,
                  threadId,
                  detail: Cause.pretty(cause),
                }).pipe(Effect.as({ available: false as const, value: [] })),
              ),
            );
          if (!projectedUserMessagesSnapshot.available) return null;
          return {
            signature: mappingSignature,
            createdAtByItemId: mapCodexUserMessageCreatedAt({
              thread,
              projectedUserMessages: projectedUserMessagesSnapshot.value,
              projectedTurnStartedAtById: new Map(
                Array.from(projectedTurnsById, ([turnId, turn]) => [
                  turnId,
                  turn.startedAt ?? turn.requestedAt,
                ]),
              ),
              projectedTurnPendingMessageIdById: new Map(
                Array.from(projectedTurnsById, ([turnId, turn]) => [turnId, turn.pendingMessageId]),
              ),
            }),
          };
        });
        if (userMessageMapping === null) return null;
        if (userMessageMapping !== cachedUserMessageMapping) {
          yield* Ref.update(transcriptUserMessageMappings, (current) => {
            const next = new Map(current);
            next.set(threadId, userMessageMapping);
            return next;
          });
        }
        const userMessageCreatedAtByItemId = userMessageMapping.createdAtByItemId;
        const snapshotSignature = codexTranscriptSnapshotSignature({
          pane,
          thread,
          userMessageCreatedAtByItemId,
        });
        const emittedAtMs = yield* Clock.currentTimeMillis;
        const cachedSnapshotMatches =
          (yield* Ref.get(transcriptSnapshotSignatures)).get(threadId) === snapshotSignature;
        const cachedActiveClassificationMatches = activeTurnId === externallyActiveTurnId;
        if (cachedSnapshotMatches && cachedActiveClassificationMatches) {
          const pendingState = yield* transcriptPublishSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const reconciled = reconcileTranscriptInFlight(
                yield* Ref.get(transcriptInFlight),
                durableFingerprints,
                eventIdPrefix,
              );
              yield* Ref.set(transcriptInFlight, reconciled);
              return {
                hasPendingEvents: hasTranscriptInFlightForPrefix(reconciled, eventIdPrefix),
                hasExpiredPendingEvents: hasExpiredTranscriptInFlightForPrefix(
                  reconciled,
                  eventIdPrefix,
                  emittedAtMs,
                ),
              };
            }),
          );
          if (!pendingState.hasExpiredPendingEvents) {
            return {
              thread,
              hasPendingEvents: pendingState.hasPendingEvents,
              hasActiveTurn: externallyActiveTurnId !== undefined,
              snapshotSignature,
            };
          }
        }
        const observedAt = yield* nowIso;
        const currentTurnIds = new Set(thread.turns.map((turn) => turn.id));
        const fallbackStartedAtByTurnId = new Map(
          (yield* Ref.get(transcriptFallbackStartedAt)).get(threadId) ?? [],
        );
        for (const turn of thread.turns) {
          if (turn.startedAt != null) {
            fallbackStartedAtByTurnId.delete(turn.id);
            continue;
          }
          const fallback = resolveHerdrTranscriptStartedAtFallback({
            projectedStartedAt: projectedTurnsById.get(turn.id)?.startedAt,
            cachedStartedAt: fallbackStartedAtByTurnId.get(turn.id),
            observedAt,
          });
          fallbackStartedAtByTurnId.set(turn.id, fallback);
        }
        for (const turnId of fallbackStartedAtByTurnId.keys()) {
          if (!currentTurnIds.has(turnId)) fallbackStartedAtByTurnId.delete(turnId);
        }
        yield* Ref.update(transcriptFallbackStartedAt, (current) => {
          const next = new Map(current);
          if (fallbackStartedAtByTurnId.size > 0) next.set(threadId, fallbackStartedAtByTurnId);
          else next.delete(threadId);
          return next;
        });
        const fallbackCompletedAtByTurnId = new Map(
          (yield* Ref.get(transcriptFallbackCompletedAt)).get(threadId) ?? [],
        );
        for (let index = 0; index < thread.turns.length; index += 1) {
          const turn = thread.turns[index]!;
          const isExternallyActiveTurn =
            index === thread.turns.length - 1 && externallyActiveTurnId === turn.id;
          const needsFallback =
            !isExternallyActiveTurn &&
            turn.status !== "inProgress" &&
            turn.completedAt == null &&
            (turn.durationMs == null || turn.startedAt == null) &&
            thread.turns[index + 1]?.startedAt == null;
          if (!needsFallback) {
            fallbackCompletedAtByTurnId.delete(turn.id);
            continue;
          }
          const fallback =
            projectedTurnsById.get(turn.id)?.completedAt ??
            fallbackCompletedAtByTurnId.get(turn.id) ??
            (thread.turns[index + 1]
              ? fallbackStartedAtByTurnId.get(thread.turns[index + 1]!.id)
              : undefined) ??
            (index === thread.turns.length - 1 ? observedAt : undefined);
          if (fallback !== undefined) fallbackCompletedAtByTurnId.set(turn.id, fallback);
        }
        for (const turnId of fallbackCompletedAtByTurnId.keys()) {
          if (!currentTurnIds.has(turnId)) fallbackCompletedAtByTurnId.delete(turnId);
        }
        yield* Ref.update(transcriptFallbackCompletedAt, (current) => {
          const next = new Map(current);
          if (fallbackCompletedAtByTurnId.size > 0) next.set(threadId, fallbackCompletedAtByTurnId);
          else next.delete(threadId);
          return next;
        });
        const events = codexThreadRuntimeEvents({
          instanceId,
          canonicalThreadId: threadId,
          sessionId,
          thread,
          observedAt,
          ...(externallyActiveTurnId !== undefined ? { externallyActiveTurnId } : {}),
          ...(fallbackStartedAtByTurnId.size > 0 ? { fallbackStartedAtByTurnId } : {}),
          ...(fallbackCompletedAtByTurnId.size > 0 ? { fallbackCompletedAtByTurnId } : {}),
          ...(userMessageCreatedAtByItemId.size > 0 ? { userMessageCreatedAtByItemId } : {}),
        });
        const prioritizedEvents = prioritizeCodexReasoningBackfill({
          events,
          durableFingerprints,
          latestTurnId: latestTurn ? TurnId.make(latestTurn.id) : undefined,
        });
        const publication = yield* transcriptPublishSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const selected = selectCodexTranscriptEventsForPublication({
              events: prioritizedEvents,
              durableFingerprints,
              inFlight: yield* Ref.get(transcriptInFlight),
              emittedAtMs,
              retryAfterMs: TRANSCRIPT_IN_FLIGHT_RETRY_MS,
              maxRetryAfterMs: TRANSCRIPT_IN_FLIGHT_MAX_RETRY_MS,
              maxRetryExponent: TRANSCRIPT_IN_FLIGHT_MAX_RETRY_EXPONENT,
              maxRetryEvents: TRANSCRIPT_IN_FLIGHT_MAX_RETRY_EVENTS,
              eventIdPrefix,
            });
            yield* Ref.set(transcriptInFlight, selected.inFlight);
            return {
              events: selected.events,
              hasPendingEvents: hasTranscriptInFlightForPrefix(selected.inFlight, eventIdPrefix),
            };
          }),
        );
        // Keep shared in-flight selection atomic, but do not let one large
        // transcript block every other active pane from publishing.
        for (const event of publication.events) {
          yield* publish(event);
        }
        const hasPendingEvents = publication.hasPendingEvents;
        yield* Ref.update(transcriptSnapshotSignatures, (current) => {
          const next = new Map(current);
          next.set(threadId, snapshotSignature);
          return next;
        });
        yield* Ref.update(latestTranscriptTurnIds, (current) => {
          const next = new Map(current);
          if (latestTurn) next.set(threadId, TurnId.make(latestTurn.id));
          else next.delete(threadId);
          return next;
        });
        yield* Ref.update(activeTurns, (current) => {
          const next = new Map(current);
          if (externallyActiveTurnId) next.set(threadId, externallyActiveTurnId);
          else next.delete(threadId);
          return next;
        });
        return {
          thread,
          hasPendingEvents,
          hasActiveTurn: externallyActiveTurnId !== undefined,
          snapshotSignature,
        };
      });

      const syncCodexPane = Effect.fn("HerdrDriver.syncCodexPane")(function* (pane: HerdrWirePane) {
        const sessionId = codexSessionId(pane);
        if (!codexReader || !sessionId) return;
        yield* Deferred.await(runtimeEventsReady);
        const threadId = herdrThreadId(instanceId, pane);
        const paneSignature = codexTranscriptPaneSignature(pane);
        const previousSignature = (yield* Ref.get(paneSignatures)).get(threadId);
        const attemptedSignature = (yield* Ref.get(paneAttemptSignatures)).get(threadId);
        const stabilizationCandidate = (yield* Ref.get(transcriptStabilizationCandidates)).get(
          threadId,
        );
        const nowMs = yield* Clock.currentTimeMillis;
        const lastRefreshAtMs = (yield* Ref.get(transcriptRefreshAtMs)).get(threadId);
        if (
          !shouldRefreshCodexTranscript(
            pane,
            previousSignature,
            attemptedSignature,
            lastRefreshAtMs,
            nowMs,
            stabilizationCandidate?.paneSignature === paneSignature,
          )
        ) {
          return;
        }
        yield* Ref.update(paneAttemptSignatures, (current) => {
          const next = new Map(current);
          next.set(threadId, paneSignature);
          return next;
        });
        yield* Ref.update(transcriptRefreshAtMs, (current) => {
          const next = new Map(current);
          next.set(threadId, nowMs);
          return next;
        });
        const synced = yield* withTranscriptThreadLock(
          threadId,
          readCodexThreadForPane(pane, threadId).pipe(
            Effect.flatMap((resolved) =>
              resolved === null ? Effect.succeed(null) : publishCodexThread(pane, resolved),
            ),
            Effect.catch((cause) =>
              Effect.logDebug("HerdR Codex transcript is unavailable for pane", {
                instanceId,
                threadId,
                sessionId,
                detail: cause.message,
              }).pipe(Effect.as(null)),
            ),
          ),
        );
        if (!synced) return;
        const idlePane = pane.agent_status !== "working" && pane.agent_status !== "blocked";
        if (idlePane) {
          const settled = yield* Ref.modify(transcriptStabilizationCandidates, (current) => {
            const next = new Map(current);
            const stabilization = advanceCodexTranscriptStabilization({
              candidate: current.get(threadId),
              paneSignature,
              snapshotSignature: synced.snapshotSignature,
              hasPendingEvents: synced.hasPendingEvents,
              hasActiveTurn: synced.hasActiveTurn,
            });
            if (stabilization.candidate) {
              next.set(threadId, stabilization.candidate);
            } else {
              next.delete(threadId);
            }
            return [stabilization.settled, next];
          });
          if (!settled) return;
        } else {
          yield* Ref.update(transcriptStabilizationCandidates, (current) => {
            if (!current.has(threadId)) return current;
            const next = new Map(current);
            next.delete(threadId);
            return next;
          });
          if (synced.hasPendingEvents) return;
        }
        yield* Ref.update(paneSignatures, (current) => {
          const next = new Map(current);
          next.set(threadId, paneSignature);
          return next;
        });
      });

      const sessionForPane = Effect.fn("HerdrDriver.sessionForPane")(function* (
        pane: HerdrWirePane,
      ) {
        const createdAt = yield* nowIso;
        const threadId = herdrThreadId(instanceId, pane);
        const activeTurnId = (yield* Ref.get(activeTurns)).get(threadId);
        return {
          provider: DRIVER_KIND,
          providerInstanceId: instanceId,
          status: toProviderStatus(pane.agent_status),
          runtimeMode: "full-access",
          cwd: pane.foreground_cwd ?? pane.cwd ?? process.cwd(),
          model: MODEL_SLUG,
          threadId,
          resumeCursor: {
            terminalId: pane.terminal_id,
            agentSession: pane.agent_session ?? null,
          },
          ...(activeTurnId ? { activeTurnId } : {}),
          createdAt,
          updatedAt: createdAt,
        } satisfies ProviderSession;
      });

      const requirePane = Effect.fn("HerdrDriver.requirePane")(function* (threadId: ThreadId) {
        const pane = yield* environment.findPane(threadId);
        if (!pane) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: DRIVER_KIND,
            threadId,
          });
        }
        return pane;
      });

      yield* HerdrEnvironmentRegistry.updates.pipe(
        Stream.filter((update) => update.instanceId === instanceId),
        Stream.runForEach((update) =>
          Effect.gen(function* () {
            const retainedThreadIds = new Set<string>(
              update.snapshot.panes.map((pane) => herdrThreadId(instanceId, pane)),
            );
            yield* Effect.all(
              [
                Ref.update(activeTurns, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(paneSignatures, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(paneAttemptSignatures, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptRefreshAtMs, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptStabilizationCandidates, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(coldStartCandidates, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(latestTranscriptTurnIds, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptFallbackStartedAt, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptFallbackCompletedAt, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(durableFingerprintCache, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptSnapshotSignatures, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptBindings, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptUserMessageMappings, (current) =>
                  retainHerdrThreadState(current, retainedThreadIds),
                ),
                Ref.update(transcriptInFlight, (current) =>
                  retainHerdrTranscriptInFlightState(current, retainedThreadIds),
                ),
                SynchronizedRef.update(transcriptThreadLocks, (current) => {
                  const retained = retainHerdrThreadState(current, retainedThreadIds);
                  return retained === current ? current : new Map(retained);
                }),
              ],
              { concurrency: "unbounded", discard: true },
            );
            const panesByTranscriptPriority = [...update.snapshot.panes].sort(
              (left, right) =>
                codexTranscriptPanePriority(left) - codexTranscriptPanePriority(right),
            );
            yield* Effect.forEach(panesByTranscriptPriority, syncCodexPane, {
              concurrency: 4,
              discard: true,
            });
            const active = yield* Ref.get(activeTurns);
            for (const [threadId, turnId] of active) {
              const pane = update.snapshot.panes.find(
                (candidate) => herdrThreadId(instanceId, candidate) === threadId,
              );
              if (pane && codexSessionId(pane) && codexReader) continue;
              if (!pane || (pane.agent_status !== "idle" && pane.agent_status !== "done")) {
                continue;
              }
              const createdAt = yield* nowIso;
              yield* publish({
                eventId: EventId.make(
                  `herdr-turn-completed:${threadId}:${turnId}:${pane.revision}`,
                ),
                provider: DRIVER_KIND,
                providerInstanceId: instanceId,
                threadId,
                turnId,
                createdAt,
                type: "turn.completed",
                payload: { state: "completed" },
              });
              yield* publish({
                eventId: EventId.make(`herdr-session-ready:${threadId}:${pane.revision}`),
                provider: DRIVER_KIND,
                providerInstanceId: instanceId,
                threadId,
                createdAt,
                type: "session.state.changed",
                payload: { state: "ready" },
              });
              yield* Ref.update(activeTurns, (current) => {
                const next = new Map(current);
                next.delete(threadId);
                return next;
              });
            }
          }),
        ),
        Effect.forkScoped,
      );

      const adapter: ProviderInstance["adapter"] = {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" },
        startSession: (input) => requirePane(input.threadId).pipe(Effect.flatMap(sessionForPane)),
        sendTurn: Effect.fn("HerdrDriver.sendTurn")(function* (input) {
          const pane = yield* requirePane(input.threadId);
          if (!input.input) {
            return yield* new ProviderAdapterRequestError({
              provider: DRIVER_KIND,
              method: "agent.send",
              detail: "HerdR turns require text input.",
            });
          }
          if ((input.attachments?.length ?? 0) > 0) {
            return yield* new ProviderAdapterRequestError({
              provider: DRIVER_KIND,
              method: "agent.send",
              detail: "Image attachments are not supported by the HerdR terminal transport yet.",
            });
          }
          const sessionId = codexSessionId(pane);
          const turnsBefore =
            codexReader && sessionId
              ? yield* withTranscriptThreadLock(
                  input.threadId,
                  readCodexThreadForPane(pane, input.threadId).pipe(
                    Effect.map(
                      (resolved) => new Set(resolved?.thread.turns.map((turn) => turn.id) ?? []),
                    ),
                    Effect.orElseSucceed(() => new Set<string>()),
                  ),
                )
              : new Set<string>();
          yield* environment.send(input.threadId, input.input).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: DRIVER_KIND,
                  method: "agent.send",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          let mirroredTurnId: TurnId | null = null;
          if (codexReader && sessionId) {
            for (let attempt = 0; attempt < 50; attempt += 1) {
              const currentPane = yield* environment.refresh.pipe(
                Effect.map(
                  (snapshot) =>
                    snapshot.panes.find(
                      (candidate) => herdrThreadId(instanceId, candidate) === input.threadId,
                    ) ?? pane,
                ),
                Effect.orElseSucceed(() => pane),
              );
              const started = yield* withTranscriptThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  const resolved = yield* readCodexThreadForPane(currentPane, input.threadId).pipe(
                    Effect.orElseSucceed(() => null),
                  );
                  if (!resolved) return undefined;
                  const started = resolved.thread.turns.findLast(
                    (turn) => !turnsBefore.has(turn.id),
                  );
                  yield* publishCodexThread(
                    currentPane,
                    resolved,
                    started ? TurnId.make(started.id) : undefined,
                  );
                  return started;
                }),
              );
              if (started) {
                mirroredTurnId = TurnId.make(started.id);
                break;
              }
              yield* Effect.sleep("100 millis");
            }
          }
          const turnId = mirroredTurnId ?? TurnId.make(yield* randomUUIDv4);
          if (mirroredTurnId !== null) {
            return { threadId: input.threadId, turnId };
          }
          const createdAt = yield* nowIso;
          yield* Ref.update(activeTurns, (current) => {
            const next = new Map(current);
            next.set(input.threadId, turnId);
            return next;
          });
          yield* publish({
            eventId: EventId.make(`herdr-turn-started:${input.threadId}:${turnId}`),
            provider: DRIVER_KIND,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            createdAt,
            type: "turn.started",
            payload: {},
          });
          yield* publish({
            eventId: EventId.make(`herdr-session-running:${input.threadId}:${turnId}`),
            provider: DRIVER_KIND,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            createdAt,
            type: "session.state.changed",
            payload: { state: "running" },
          });
          return { threadId: input.threadId, turnId };
        }),
        interruptTurn: Effect.fn("HerdrDriver.interruptTurn")(function* (threadId) {
          yield* environment.interrupt(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: DRIVER_KIND,
                  method: "pane.send_input",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const activeTurnId = (yield* Ref.get(activeTurns)).get(threadId);
          if (activeTurnId) {
            const createdAt = yield* nowIso;
            yield* publish({
              eventId: EventId.make(`herdr-turn-aborted:${threadId}:${activeTurnId}`),
              provider: DRIVER_KIND,
              providerInstanceId: instanceId,
              threadId,
              turnId: activeTurnId,
              createdAt,
              type: "turn.aborted",
              payload: { reason: "Interrupted from T3 Code" },
            });
            yield* Ref.update(activeTurns, (current) => {
              const next = new Map(current);
              next.delete(threadId);
              return next;
            });
          }
        }),
        respondToRequest: Effect.fn("HerdrDriver.respondToRequest")(
          function* (threadId, _requestId, decision) {
            const answer =
              decision === "accept" ? "y" : decision === "acceptForSession" ? "a" : "n";
            yield* environment.send(threadId, answer).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: DRIVER_KIND,
                    method: "approval.respond",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          },
        ),
        respondToUserInput: Effect.fn("HerdrDriver.respondToUserInput")(
          function* (threadId, _requestId, answers) {
            const text = Object.values(answers)
              .flatMap((value) =>
                Array.isArray(value)
                  ? value.map(String)
                  : value === undefined
                    ? []
                    : [String(value)],
              )
              .join("\n");
            yield* environment.send(threadId, text).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: DRIVER_KIND,
                    method: "user-input.respond",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          },
        ),
        // HerdR owns the process lifetime. Stopping or shutting down T3 must never close a pane.
        stopSession: () => Effect.void,
        listSessions: () =>
          Effect.gen(function* () {
            const snapshot = yield* environment.getSnapshot;
            if (!snapshot) return [];
            return yield* Effect.forEach(
              snapshot.panes.filter((pane) => pane.agent),
              sessionForPane,
            );
          }),
        hasSession: (threadId) =>
          environment.findPane(threadId).pipe(Effect.map((pane) => pane !== null)),
        readThread: (threadId) => requirePane(threadId).pipe(Effect.as({ threadId, turns: [] })),
        rollbackThread: (threadId) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: DRIVER_KIND,
              method: "thread.rollback",
              detail: `Rollback is not supported for externally owned HerdR thread '${threadId}'.`,
            }),
          ),
        stopAll: () => Effect.void,
        streamEvents: Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(runtimeEvents);
            yield* Deferred.succeed(runtimeEventsReady, undefined);
            return Stream.fromSubscription(subscription);
          }),
        ),
      };

      const snapshotForCurrentState = Effect.gen(function* () {
        const now = yield* nowIso;
        const snapshot = yield* environment.getSnapshot;
        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName ?? "HerdR",
          ...(accentColor ? { accentColor } : {}),
          badgeLabel: "External",
          continuation: { groupKey: `herdr:socket:${environment.socketPath}` },
          showInteractionModeToggle: false,
          requiresNewThreadForModelChange: true,
          enabled,
          installed: snapshot !== null,
          version: snapshot?.version ?? null,
          status: enabled ? (snapshot ? "ready" : "error") : "disabled",
          auth: { status: "authenticated", type: "local-socket", label: "HerdR server" },
          checkedAt: now,
          ...(snapshot ? {} : { message: `Cannot reach HerdR at ${environment.socketPath}.` }),
          models: [
            {
              slug: MODEL_SLUG,
              name: "HerdR managed agent",
              shortName: "HerdR",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });

      const providerSnapshot: ServerProviderShape = {
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSnapshot: snapshotForCurrentState,
        refresh: environment.refresh.pipe(
          Effect.ignore,
          Effect.flatMap(() => snapshotForCurrentState),
        ),
        streamChanges: HerdrEnvironmentRegistry.updates.pipe(
          Stream.filter((update) => update.instanceId === instanceId),
          Stream.mapEffect(() => snapshotForCurrentState),
        ),
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          driverKind: DRIVER_KIND,
          continuationKey: `herdr:socket:${environment.socketPath}`,
        },
        displayName,
        accentColor,
        enabled,
        snapshot: providerSnapshot,
        adapter,
        textGeneration: herdrTextGeneration,
      } satisfies ProviderInstance;
    }),
};
