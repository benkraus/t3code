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
  codexThreadRuntimeEvents,
  codexTranscriptPanePriority,
  codexTranscriptPaneSignature,
  resolveCodexExternallyActiveTurnId,
  selectCodexTranscriptEventsForPublication,
  staleCodexCompletionReceiptEventId,
  shouldRefreshCodexTranscript,
  type CodexColdStartCandidate,
  type CodexTranscriptStabilizationCandidate,
} from "../../herdr/codexTranscript.ts";
import * as HerdrEnvironmentRegistry from "../../herdr/HerdrEnvironmentRegistry.ts";
import { herdrThreadId, splitCommand } from "../../herdr/identity.ts";
import type { HerdrWirePane } from "../../herdr/HerdrSocketClient.ts";
import { ProviderRuntimeEventReceiptRepository } from "../../persistence/Services/ProviderRuntimeEventReceipts.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
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

function codexSnapshotSignature(pane: HerdrWirePane, thread: CodexThreadSnapshot): string {
  return jsonSha256([pane.agent_status, pane.revision, pane.agent_session, thread]);
}

export function codexLatestTurnSnapshotSignature(
  turn: CodexThreadSnapshot["turns"][number],
): string {
  return jsonSha256(turn);
}

export type HerdrDriverEnv =
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | ProviderRuntimeEventReceiptRepository
  | ProjectionTurnRepository;

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
      const runtimeEventReceipts = yield* ProviderRuntimeEventReceiptRepository;
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

      const publishCodexThread = Effect.fn("HerdrDriver.publishCodexThread")(function* (
        pane: HerdrWirePane,
        thread: CodexThreadSnapshot,
        forcedActiveTurnId?: TurnId,
      ) {
        const sessionId = codexSessionId(pane);
        if (!sessionId) return null;
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
        const needsProjectedTurns =
          needsColdExternalClassification ||
          thread.turns.some(
            (turn) =>
              turn.startedAt == null || (turn.completedAt == null && turn.durationMs == null),
          );
        const projectedTurnsSnapshot = needsProjectedTurns
          ? yield* projectionTurns.listByThreadId({ threadId }).pipe(
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
            )
          : { available: true as const, value: [] };
        if (needsProjectedTurns && !projectedTurnsSnapshot.available) {
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
        const snapshotSignature = codexSnapshotSignature(pane, thread);
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
        });
        const hasPendingEvents = yield* transcriptPublishSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const selected = selectCodexTranscriptEventsForPublication({
              events,
              durableFingerprints,
              inFlight: yield* Ref.get(transcriptInFlight),
              emittedAtMs,
              retryAfterMs: TRANSCRIPT_IN_FLIGHT_RETRY_MS,
              maxRetryAfterMs: TRANSCRIPT_IN_FLIGHT_MAX_RETRY_MS,
              maxRetryExponent: TRANSCRIPT_IN_FLIGHT_MAX_RETRY_EXPONENT,
              maxRetryEvents: TRANSCRIPT_IN_FLIGHT_MAX_RETRY_EVENTS,
              eventIdPrefix,
            });
            for (const event of selected.events) {
              yield* publish(event);
            }
            yield* Ref.set(transcriptInFlight, selected.inFlight);
            return hasTranscriptInFlightForPrefix(selected.inFlight, eventIdPrefix);
          }),
        );
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
          codexReader.readThread(sessionId).pipe(
            Effect.flatMap((thread) => publishCodexThread(pane, thread)),
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
                  codexReader.readThread(sessionId).pipe(
                    Effect.map((thread) => new Set(thread.turns.map((turn) => turn.id))),
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
                  const thread = yield* codexReader
                    .readThread(sessionId)
                    .pipe(Effect.orElseSucceed(() => null));
                  if (!thread) return undefined;
                  const started = thread.turns.findLast((turn) => !turnsBefore.has(turn.id));
                  yield* publishCodexThread(
                    currentPane,
                    thread,
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
