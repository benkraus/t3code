import {
  HerdrRuntimeError,
  type HerdrPaneBinding,
  type HerdrPaneSnapshot,
  type HerdrSettings,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { expandHomePath } from "../pathExpansion.ts";
import {
  HerdrSocketClient,
  HerdrSocketRequestError,
  type HerdrWirePane,
  type HerdrWireSnapshot,
} from "./HerdrSocketClient.ts";
import { herdrLaunchName, herdrThreadId, splitCommand } from "./identity.ts";
import { isAgentInputReady } from "./readiness.ts";
import { selectWorkspaceForCwd } from "./workspaceSelection.ts";

export interface HerdrEnvironmentUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: HerdrWireSnapshot;
}

export interface HerdrEnvironment {
  readonly instanceId: ProviderInstanceId;
  readonly settings: HerdrSettings;
  readonly socketPath: string;
  readonly getSnapshot: Effect.Effect<HerdrWireSnapshot | null>;
  readonly refresh: Effect.Effect<HerdrWireSnapshot, HerdrRuntimeError>;
  readonly readPane: (threadId: ThreadId) => Effect.Effect<HerdrPaneSnapshot, HerdrRuntimeError>;
  readonly send: (threadId: ThreadId, text: string) => Effect.Effect<void, HerdrRuntimeError>;
  readonly interrupt: (threadId: ThreadId) => Effect.Effect<void, HerdrRuntimeError>;
  readonly closePane: (threadId: ThreadId) => Effect.Effect<void, HerdrRuntimeError>;
  readonly createThread: (
    cwd: string,
    title?: string,
  ) => Effect.Effect<ThreadId, HerdrRuntimeError>;
  readonly findPane: (threadId: ThreadId) => Effect.Effect<HerdrWirePane | null>;
}

const environments = new Map<ProviderInstanceId, HerdrEnvironment>();
const updateSubscribers = new Set<(update: HerdrEnvironmentUpdate) => void>();

function publishUpdate(update: HerdrEnvironmentUpdate): void {
  for (const subscriber of updateSubscribers) subscriber(update);
}

export const updates: Stream.Stream<HerdrEnvironmentUpdate> = Stream.callback((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const subscriber = (update: HerdrEnvironmentUpdate) => Queue.offerUnsafe(queue, update);
      updateSubscribers.add(subscriber);
      return subscriber;
    }),
    (subscriber) => Effect.sync(() => updateSubscribers.delete(subscriber)),
  ),
);

export const getEnvironment = (instanceId: ProviderInstanceId) =>
  Effect.sync(() => environments.get(instanceId));

export const listEnvironments = Effect.sync(() => [...environments.values()]);

function runtimeError(operation: string, cause: unknown): HerdrRuntimeError {
  const message =
    cause instanceof HerdrSocketRequestError || cause instanceof Error
      ? cause.message
      : String(cause);
  return new HerdrRuntimeError({ operation, message });
}

function paneBinding(instanceId: ProviderInstanceId, pane: HerdrWirePane): HerdrPaneBinding {
  return {
    instanceId,
    threadId: herdrThreadId(instanceId, pane),
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    workspaceId: pane.workspace_id,
    tabId: pane.tab_id,
    agent: pane.agent ?? null,
    agentSessionSource: pane.agent_session?.source ?? null,
    agentSessionKind: pane.agent_session?.kind ?? null,
    agentSessionValue: pane.agent_session?.value ?? null,
    cwd: pane.foreground_cwd ?? pane.cwd ?? process.cwd(),
    status: pane.agent_status,
  };
}

export const registerEnvironment = Effect.fn("HerdrEnvironmentRegistry.registerEnvironment")(
  function* (
    instanceId: ProviderInstanceId,
    settings: HerdrSettings,
  ): Effect.fn.Return<HerdrEnvironment, never, Scope.Scope> {
    const client = new HerdrSocketClient(expandHomePath(settings.socketPath));
    let latestSnapshot: HerdrWireSnapshot | null = null;

    const refresh = Effect.tryPromise({
      try: () => client.snapshot(),
      catch: (cause) => runtimeError("session.snapshot", cause),
    }).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          latestSnapshot = snapshot;
          publishUpdate({ instanceId, snapshot });
        }),
      ),
    );

    const findPane = (threadId: ThreadId) =>
      Effect.sync(
        () =>
          latestSnapshot?.panes.find((pane) => herdrThreadId(instanceId, pane) === threadId) ??
          null,
      );

    const requirePane = Effect.fn("HerdrEnvironment.requirePane")(function* (threadId: ThreadId) {
      const cached = yield* findPane(threadId);
      const current =
        cached ??
        (yield* refresh).panes.find((pane) => herdrThreadId(instanceId, pane) === threadId) ??
        null;
      if (!current) {
        return yield* new HerdrRuntimeError({
          operation: "thread.lookup",
          message: `No live HerdR pane is mapped to thread '${threadId}'.`,
        });
      }
      return current;
    });

    const readPane: HerdrEnvironment["readPane"] = Effect.fn("HerdrEnvironment.readPane")(
      function* (threadId) {
        const pane = yield* requirePane(threadId);
        const read = yield* Effect.tryPromise({
          try: () => client.readPane(pane.pane_id),
          catch: (cause) => runtimeError("pane.read", cause),
        });
        return {
          binding: paneBinding(instanceId, pane),
          text: read.text,
          revision: read.revision,
          truncated: read.truncated,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        } satisfies HerdrPaneSnapshot;
      },
    );

    const send: HerdrEnvironment["send"] = Effect.fn("HerdrEnvironment.send")(
      function* (threadId, text) {
        const pane = yield* requirePane(threadId);
        yield* Effect.tryPromise({
          try: () => client.submitAgent(pane.pane_id, text),
          catch: (cause) => runtimeError("agent.send", cause),
        });
        yield* refresh.pipe(Effect.ignore);
      },
    );

    const interrupt: HerdrEnvironment["interrupt"] = Effect.fn("HerdrEnvironment.interrupt")(
      function* (threadId) {
        const pane = yield* requirePane(threadId);
        yield* Effect.tryPromise({
          try: () => client.sendInput(pane.pane_id, { keys: ["Ctrl-C"] }),
          catch: (cause) => runtimeError("pane.send_input", cause),
        });
      },
    );

    const closePane: HerdrEnvironment["closePane"] = Effect.fn("HerdrEnvironment.closePane")(
      function* (threadId) {
        const pane = yield* requirePane(threadId);
        yield* Effect.tryPromise({
          try: () => client.closePane(pane.pane_id),
          catch: (cause) => runtimeError("pane.close", cause),
        });
        yield* refresh.pipe(Effect.ignore);
      },
    );

    const createThread: HerdrEnvironment["createThread"] = Effect.fn(
      "HerdrEnvironment.createThread",
    )(function* (cwd, title) {
      const argv = splitCommand(settings.agentCommand);
      if (argv.length === 0) {
        return yield* new HerdrRuntimeError({
          operation: "agent.start",
          message: "The configured HerdR agent command is empty.",
        });
      }
      const snapshot = yield* refresh;
      const workspace = selectWorkspaceForCwd(snapshot, cwd);
      if (!workspace) {
        return yield* new HerdrRuntimeError({
          operation: "agent.start",
          message: `No HerdR workspace is mapped to '${cwd}'. Open that repository in HerdR before creating a thread from T3 Code.`,
        });
      }
      const created = yield* Effect.tryPromise({
        try: () =>
          client.createTab({
            workspaceId: workspace.workspace_id,
            cwd,
            label: title?.trim() || "T3 Code",
          }),
        catch: (cause) => runtimeError("tab.create", cause),
      });

      const cleanupPane = (paneId: string) =>
        Effect.tryPromise({
          try: () => client.closePane(paneId),
          catch: () => undefined,
        }).pipe(Effect.ignore);

      const pane = yield* Effect.gen(function* () {
        const agentName = settings.agentName.trim() || "codex";
        const started = yield* Effect.tryPromise({
          try: () =>
            client.startAgent({
              name: herdrLaunchName(agentName, created.rootPane.terminal_id),
              argv,
              cwd,
              workspaceId: workspace.workspace_id,
              tabId: created.tab.tab_id,
            }),
          catch: (cause) => runtimeError("agent.start", cause),
        }).pipe(Effect.onError(() => cleanupPane(created.rootPane.pane_id)));

        yield* Effect.tryPromise({
          try: () => client.closePane(created.rootPane.pane_id),
          catch: (cause) => runtimeError("pane.close", cause),
        }).pipe(Effect.onError(() => cleanupPane(started.pane_id)));

        return yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const current = (yield* refresh).panes.find(
              (candidate) => candidate.terminal_id === started.terminal_id,
            );
            if (current) {
              const read = yield* Effect.tryPromise({
                try: () => client.readPane(current.pane_id, 200),
                catch: (cause) => runtimeError("pane.read", cause),
              });
              if (isAgentInputReady(agentName, current.agent_status, read.text)) return current;
            }
            yield* Effect.sleep("100 millis");
          }

          return yield* new HerdrRuntimeError({
            operation: "agent.ready",
            message: `HerdR agent '${agentName}' did not become ready for input.`,
          });
        }).pipe(Effect.onError(() => cleanupPane(started.pane_id)));
      });

      return herdrThreadId(instanceId, pane);
    });

    const environment: HerdrEnvironment = {
      instanceId,
      settings,
      socketPath: client.socketPath,
      getSnapshot: Effect.sync(() => latestSnapshot),
      refresh,
      readPane,
      send,
      interrupt,
      closePane,
      createThread,
      findPane,
    };

    environments.set(instanceId, environment);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (environments.get(instanceId) === environment) environments.delete(instanceId);
      }),
    );

    yield* refresh.pipe(
      Effect.catch((error) =>
        Effect.logWarning("HerdR environment is not reachable yet", {
          instanceId,
          socketPath: client.socketPath,
          detail: error.message,
        }),
      ),
    );
    yield* Effect.forever(
      Effect.sleep(`${settings.pollIntervalMs} millis`).pipe(
        Effect.flatMap(() => refresh),
        Effect.catch((error) =>
          Effect.logDebug("HerdR snapshot refresh failed", {
            instanceId,
            detail: error.message,
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);

    return environment;
  },
);

export const findByThreadId = Effect.fn("HerdrEnvironmentRegistry.findByThreadId")(function* (
  threadId: ThreadId,
) {
  for (const environment of environments.values()) {
    const cached = yield* environment.findPane(threadId);
    if (cached) return { environment, pane: cached } as const;
    const refreshed = yield* environment.refresh.pipe(
      Effect.map((snapshot) =>
        snapshot.panes.find((pane) => herdrThreadId(environment.instanceId, pane) === threadId),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (refreshed) return { environment, pane: refreshed } as const;
  }
  return null;
});

export const watchPane = (
  threadId: ThreadId,
): Stream.Stream<HerdrPaneSnapshot, HerdrRuntimeError> =>
  Stream.unwrap(
    findByThreadId(threadId).pipe(
      Effect.flatMap((match) =>
        match
          ? Effect.succeed(
              Stream.concat(
                Stream.fromEffect(match.environment.readPane(threadId)),
                updates.pipe(
                  Stream.filter((update) => update.instanceId === match.environment.instanceId),
                  Stream.filter((update) =>
                    update.snapshot.panes.some(
                      (pane) => herdrThreadId(update.instanceId, pane) === threadId,
                    ),
                  ),
                  Stream.mapEffect(() => match.environment.readPane(threadId)),
                  Stream.changesWith(
                    (previous, current) =>
                      previous.revision === current.revision && previous.text === current.text,
                  ),
                ),
              ),
            )
          : Effect.fail(
              new HerdrRuntimeError({
                operation: "pane.subscribe",
                message: `No live HerdR pane is mapped to thread '${threadId}'.`,
              }),
            ),
      ),
    ),
  );
