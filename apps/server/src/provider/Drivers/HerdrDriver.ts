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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { makeCodexThreadReader, type CodexThreadReader } from "../../herdr/CodexThreadReader.ts";
import { codexThreadRuntimeEvents, runtimeEventFingerprint } from "../../herdr/codexTranscript.ts";
import * as HerdrEnvironmentRegistry from "../../herdr/HerdrEnvironmentRegistry.ts";
import { herdrThreadId, splitCommand } from "../../herdr/identity.ts";
import type { HerdrWirePane } from "../../herdr/HerdrSocketClient.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const DRIVER_KIND = ProviderDriverKind.make("herdr");
const MODEL_SLUG = "herdr-managed";
const decodeSettings = Schema.decodeSync(HerdrSettings);

export type HerdrDriverEnv = Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner;

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
      const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const activeTurns = yield* Ref.make<ReadonlyMap<ThreadId, TurnId>>(new Map());
      const paneSignatures = yield* Ref.make<ReadonlyMap<ThreadId, string>>(new Map());
      const transcriptFingerprints = yield* Ref.make<
        ReadonlyMap<ThreadId, ReadonlyMap<string, string>>
      >(new Map());
      const command = splitCommand(config.agentCommand);
      const codexReader: CodexThreadReader | null =
        (config.agentName.trim().toLowerCase() === "codex" ||
          command[0]?.toLowerCase().includes("codex")) &&
        command[0]
          ? yield* makeCodexThreadReader({
              binaryPath: command[0],
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

      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

      const publishCodexThread = Effect.fn("HerdrDriver.publishCodexThread")(function* (
        pane: HerdrWirePane,
        reader: CodexThreadReader,
      ) {
        const sessionId = codexSessionId(pane);
        if (!sessionId) return null;
        const threadId = herdrThreadId(instanceId, pane);
        const thread = yield* reader.readThread(sessionId);
        const events = codexThreadRuntimeEvents({
          instanceId,
          canonicalThreadId: threadId,
          sessionId,
          thread,
          observedAt: yield* nowIso,
        });
        const previousByEventId =
          (yield* Ref.get(transcriptFingerprints)).get(threadId) ?? new Map<string, string>();
        const nextByEventId = new Map(previousByEventId);
        for (const event of events) {
          const fingerprint = runtimeEventFingerprint(event);
          if (previousByEventId.get(event.eventId) === fingerprint) continue;
          yield* publish(event);
          nextByEventId.set(event.eventId, fingerprint);
        }
        yield* Ref.update(transcriptFingerprints, (current) => {
          const next = new Map(current);
          next.set(threadId, nextByEventId);
          return next;
        });
        const activeTurn = thread.turns.findLast((turn) => turn.status === "inProgress");
        yield* Ref.update(activeTurns, (current) => {
          const next = new Map(current);
          if (activeTurn) next.set(threadId, TurnId.make(activeTurn.id));
          else next.delete(threadId);
          return next;
        });
        return thread;
      });

      const syncCodexPane = Effect.fn("HerdrDriver.syncCodexPane")(function* (pane: HerdrWirePane) {
        if (!codexReader || !codexSessionId(pane)) return;
        const threadId = herdrThreadId(instanceId, pane);
        const signature = `${pane.agent_session?.value}:${pane.revision}:${pane.agent_status}`;
        if ((yield* Ref.get(paneSignatures)).get(threadId) === signature) return;
        yield* publishCodexThread(pane, codexReader).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("HerdR Codex transcript is unavailable for pane", {
              instanceId,
              threadId,
              sessionId: codexSessionId(pane),
              detail: cause.message,
            }),
          ),
        );
        yield* Ref.update(paneSignatures, (current) => {
          const next = new Map(current);
          next.set(threadId, signature);
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
            yield* Effect.forEach(update.snapshot.panes, syncCodexPane, {
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
              ? yield* codexReader.readThread(sessionId).pipe(
                  Effect.map((thread) => new Set(thread.turns.map((turn) => turn.id))),
                  Effect.orElseSucceed(() => new Set<string>()),
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
              const thread = yield* publishCodexThread(pane, codexReader).pipe(
                Effect.orElseSucceed(() => null),
              );
              const started = thread?.turns.findLast((turn) => !turnsBefore.has(turn.id));
              if (started) {
                mirroredTurnId = TurnId.make(started.id);
                break;
              }
              yield* Effect.sleep("100 millis");
            }
          }
          const turnId = mirroredTurnId ?? TurnId.make(yield* randomUUIDv4);
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
        streamEvents: Stream.fromPubSub(runtimeEvents),
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
