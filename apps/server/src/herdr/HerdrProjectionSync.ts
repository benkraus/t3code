import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type HerdrAgentStatus,
  type OrchestrationSessionStatus,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { HerdrProjectionVisibility } from "../persistence/Services/HerdrProjectionVisibility.ts";
import { HerdrProjectionVisibilityRepository } from "../persistence/Services/HerdrProjectionVisibility.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as HerdrEnvironmentRegistry from "./HerdrEnvironmentRegistry.ts";
import type { HerdrWirePane, HerdrWireSnapshot, HerdrWireWorkspace } from "./HerdrSocketClient.ts";
import { herdrProjectId, herdrThreadId } from "./identity.ts";

const HERDR_DRIVER = ProviderDriverKind.make("herdr");
const HERDR_MODEL = "herdr-managed";

export function isLegacyHerdrProjectionThread(
  thread: {
    readonly id: ThreadId;
    readonly session: {
      readonly providerName: string | null;
      readonly providerInstanceId?: ProviderInstanceId | null | undefined;
    } | null;
  },
  instanceId: ProviderInstanceId,
): boolean {
  return (
    thread.id.startsWith("herdr-thread-") &&
    thread.session?.providerName === HERDR_DRIVER &&
    (thread.session.providerInstanceId === instanceId ||
      (thread.session.providerInstanceId == null && instanceId === "herdr"))
  );
}

export function herdrThreadVisibilityAction(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
  };
  readonly isLive: boolean;
  readonly visibility: Pick<HerdrProjectionVisibility, "archiveCommandId" | "autoArchivedAt">;
}): "archive" | "recover-archive" | "unarchive" | "clear-auto-archive" | null {
  const { thread } = input;
  if (thread.deletedAt !== null) return null;
  if (input.visibility.archiveCommandId !== null) {
    if (input.visibility.autoArchivedAt === null) {
      return input.isLive && thread.archivedAt === null ? "clear-auto-archive" : "recover-archive";
    }
    if (input.isLive) {
      return thread.archivedAt === null ? "clear-auto-archive" : "unarchive";
    }
    return thread.archivedAt === null ? "archive" : null;
  }
  return !input.isLive && thread.archivedAt === null ? "archive" : null;
}

function sessionStatus(status: HerdrAgentStatus): OrchestrationSessionStatus {
  switch (status) {
    case "working":
    case "blocked":
      return "running";
    case "idle":
    case "done":
      return "ready";
    case "unknown":
      return "idle";
  }
}

function workspaceRoot(workspace: HerdrWireWorkspace, panes: ReadonlyArray<HerdrWirePane>): string {
  return (
    workspace.worktree?.repo_root ??
    workspace.worktree?.checkout_path ??
    panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd ??
    process.cwd()
  );
}

function paneTitle(
  pane: HerdrWirePane,
  workspace: HerdrWireWorkspace,
  snapshot: HerdrWireSnapshot,
): string {
  const tab = snapshot.tabs.find((candidate) => candidate.tab_id === pane.tab_id);
  return (
    pane.title?.trim() ||
    pane.terminal_title_stripped?.trim() ||
    pane.label?.trim() ||
    tab?.label.trim() ||
    `${pane.agent ?? "Agent"} in ${workspace.label}`
  );
}

export class HerdrProjectionSync extends Context.Service<
  HerdrProjectionSync,
  { readonly start: Effect.Effect<void, never, Scope.Scope> }
>()("t3/herdr/HerdrProjectionSync") {}

const make = Effect.gen(function* () {
  const orchestration = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const visibility = yield* HerdrProjectionVisibilityRepository;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const crypto = yield* Crypto.Crypto;

  const commandId = Effect.fn("HerdrProjectionSync.commandId")(function* (prefix: string) {
    return CommandId.make(`${prefix}:${yield* crypto.randomUUIDv4}`);
  });

  const reconcile = Effect.fn("HerdrProjectionSync.reconcile")(function* (
    instanceId: Parameters<typeof herdrThreadId>[0],
    snapshot: HerdrWireSnapshot,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    let readModel = yield* projections.getSnapshot();
    const visibilityByThreadId = new Map(
      (yield* visibility.listByInstanceId({ providerInstanceId: instanceId })).map((entry) => [
        entry.threadId,
        entry,
      ]),
    );
    const workspaces = new Map(
      snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
    );
    const liveThreadIds = new Set<ThreadId>();

    const ensureOwned = Effect.fn("HerdrProjectionSync.ensureOwned")(function* (
      threadId: ThreadId,
    ) {
      const existing = visibilityByThreadId.get(threadId);
      if (existing?.providerInstanceId === instanceId) return existing;
      yield* visibility.ensureOwned({ threadId, providerInstanceId: instanceId });
      const owned = {
        threadId,
        providerInstanceId: instanceId,
        archiveCommandId: existing?.archiveCommandId ?? null,
        autoArchivedAt: existing?.autoArchivedAt ?? null,
      } satisfies HerdrProjectionVisibility;
      visibilityByThreadId.set(threadId, owned);
      return owned;
    });

    const clearAutoArchive = Effect.fn("HerdrProjectionSync.clearAutoArchive")(function* (
      threadId: ThreadId,
    ) {
      yield* visibility.clearAutoArchive({ threadId });
      const existing = visibilityByThreadId.get(threadId);
      if (existing) {
        visibilityByThreadId.set(threadId, {
          ...existing,
          archiveCommandId: null,
          autoArchivedAt: null,
        });
      }
    });

    const finishAutoArchive = Effect.fn("HerdrProjectionSync.finishAutoArchive")(function* (
      threadId: ThreadId,
      archiveCommandId: CommandId,
      isLive: boolean,
    ) {
      const accepted = yield* orchestration
        .dispatch({ type: "thread.archive", commandId: archiveCommandId, threadId })
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            OrchestrationCommandInvariantError: () =>
              clearAutoArchive(threadId).pipe(Effect.as(false)),
            OrchestrationCommandPreviouslyRejectedError: () =>
              clearAutoArchive(threadId).pipe(Effect.as(false)),
          }),
        );
      if (!accepted) return;

      const latestThread = Option.getOrUndefined(
        yield* projections.getThreadShellById(threadId, { includeArchived: true }),
      );
      if (!latestThread) {
        yield* visibility.deleteByThreadId({ threadId });
        visibilityByThreadId.delete(threadId);
        return;
      }
      if (isLive) {
        if (latestThread.archivedAt !== null) {
          yield* orchestration.dispatch({
            type: "thread.unarchive",
            commandId: yield* commandId("herdr-thread-unarchive"),
            threadId,
            expectedArchiveCommandId: archiveCommandId,
          });
        }
        yield* clearAutoArchive(threadId);
        return;
      }
      if (latestThread.archivedAt === null) {
        yield* clearAutoArchive(threadId);
        return;
      }
      const terminalClosed = yield* terminalManager.close({ threadId }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Failed to close terminals after external thread archive", {
            threadId,
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!terminalClosed) return;
      yield* visibility.completeAutoArchive({ threadId, archiveCommandId, autoArchivedAt: now });
      const existing = visibilityByThreadId.get(threadId);
      if (existing) {
        visibilityByThreadId.set(threadId, {
          ...existing,
          archiveCommandId,
          autoArchivedAt: now,
        });
      }
    });

    for (const pane of snapshot.panes) {
      if (!pane.agent) continue;
      const workspace = workspaces.get(pane.workspace_id);
      if (!workspace) continue;
      const projectId = herdrProjectId(instanceId, workspace);
      const threadId = herdrThreadId(instanceId, pane);
      liveThreadIds.add(threadId);
      yield* ensureOwned(threadId);
      const root = workspaceRoot(workspace, snapshot.panes);
      const projectTitle = workspace.worktree?.repo_name?.trim() || workspace.label.trim();
      const existingProject = readModel.projects.find((project) => project.id === projectId);
      if (!existingProject) {
        yield* orchestration.dispatch({
          type: "project.create",
          commandId: yield* commandId("herdr-project-create"),
          projectId,
          title: projectTitle,
          workspaceRoot: root,
          defaultModelSelection: { instanceId, model: HERDR_MODEL },
          createdAt: now,
        });
        readModel = yield* projections.getSnapshot();
      } else if (existingProject.title !== projectTitle || existingProject.workspaceRoot !== root) {
        yield* orchestration.dispatch({
          type: "project.meta.update",
          commandId: yield* commandId("herdr-project-update"),
          projectId,
          ...(existingProject.title !== projectTitle ? { title: projectTitle } : {}),
          ...(existingProject.workspaceRoot !== root ? { workspaceRoot: root } : {}),
        });
        readModel = yield* projections.getSnapshot();
      }

      const title = paneTitle(pane, workspace, snapshot);
      const worktreePath =
        workspace.worktree?.checkout_path ?? pane.foreground_cwd ?? pane.cwd ?? null;
      let existingThread = readModel.threads.find((thread) => thread.id === threadId);
      if (!existingThread) {
        yield* orchestration.dispatch({
          type: "thread.create",
          commandId: yield* commandId("herdr-thread-create"),
          threadId,
          projectId,
          title,
          modelSelection: { instanceId, model: HERDR_MODEL },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath,
          createdAt: now,
        });
        readModel = yield* projections.getSnapshot();
        existingThread = readModel.threads.find((thread) => thread.id === threadId);
      } else if (
        existingThread.projectId !== projectId ||
        existingThread.title !== title ||
        existingThread.worktreePath !== worktreePath
      ) {
        yield* orchestration.dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("herdr-thread-update"),
          threadId,
          ...(existingThread.projectId !== projectId ? { projectId } : {}),
          ...(existingThread.title !== title ? { title } : {}),
          ...(existingThread.worktreePath !== worktreePath ? { worktreePath } : {}),
        });
        readModel = yield* projections.getSnapshot();
        existingThread = readModel.threads.find((thread) => thread.id === threadId);
      }

      const nextStatus = sessionStatus(pane.agent_status);
      const currentSession = existingThread?.session;
      if (
        !currentSession ||
        currentSession.status !== nextStatus ||
        currentSession.providerInstanceId !== instanceId ||
        currentSession.providerName !== HERDR_DRIVER
      ) {
        yield* orchestration.dispatch({
          type: "thread.session.set",
          commandId: yield* commandId("herdr-session-set"),
          threadId,
          session: {
            threadId,
            status: nextStatus,
            providerName: HERDR_DRIVER,
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            activeTurnId: currentSession?.activeTurnId ?? null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    readModel = yield* projections.getSnapshot();
    for (const thread of readModel.threads) {
      let threadVisibility = visibilityByThreadId.get(thread.id);
      if (!threadVisibility && isLegacyHerdrProjectionThread(thread, instanceId)) {
        threadVisibility = yield* ensureOwned(thread.id);
      }
      if (!threadVisibility || threadVisibility.providerInstanceId !== instanceId) continue;
      if (thread.deletedAt !== null) {
        yield* visibility.deleteByThreadId({ threadId: thread.id });
        visibilityByThreadId.delete(thread.id);
        continue;
      }

      const isLive = liveThreadIds.has(thread.id);
      if (!isLive && thread.session && thread.session.status !== "stopped") {
        yield* orchestration.dispatch({
          type: "thread.session.set",
          commandId: yield* commandId("herdr-session-stopped"),
          threadId: thread.id,
          session: {
            ...thread.session,
            status: "stopped",
            activeTurnId: null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
      if (
        thread.archivedAt !== null &&
        threadVisibility.archiveCommandId !== null &&
        (threadVisibility.autoArchivedAt === null || isLive)
      ) {
        if (thread.archiveCommandId !== threadVisibility.archiveCommandId) {
          yield* clearAutoArchive(thread.id);
          threadVisibility = {
            ...threadVisibility,
            archiveCommandId: null,
            autoArchivedAt: null,
          };
        }
      }
      const visibilityAction = herdrThreadVisibilityAction({
        thread,
        isLive,
        visibility: threadVisibility,
      });
      if (visibilityAction === "unarchive") {
        yield* orchestration.dispatch({
          type: "thread.unarchive",
          commandId: yield* commandId("herdr-thread-unarchive"),
          threadId: thread.id,
          expectedArchiveCommandId: threadVisibility.archiveCommandId ?? undefined,
        });
        yield* clearAutoArchive(thread.id);
        continue;
      }
      if (visibilityAction === "clear-auto-archive") {
        yield* clearAutoArchive(thread.id);
        continue;
      }
      if (visibilityAction === "recover-archive") {
        const pendingCommandId = threadVisibility.archiveCommandId;
        if (pendingCommandId !== null) {
          yield* finishAutoArchive(thread.id, pendingCommandId, isLive);
        }
        continue;
      }
      if (visibilityAction !== "archive") continue;
      const archiveCommandId = yield* commandId("herdr-thread-archive");
      yield* visibility.beginAutoArchive({
        threadId: thread.id,
        providerInstanceId: instanceId,
        archiveCommandId,
      });
      visibilityByThreadId.set(thread.id, {
        ...threadVisibility,
        archiveCommandId,
        autoArchivedAt: null,
      });
      yield* finishAutoArchive(thread.id, archiveCommandId, false);
    }

    const persistedThreadIds = new Set(readModel.threads.map((thread) => thread.id));
    for (const entry of visibilityByThreadId.values()) {
      if (persistedThreadIds.has(entry.threadId)) continue;
      yield* visibility.deleteByThreadId({ threadId: entry.threadId });
    }
  });

  const start = HerdrEnvironmentRegistry.updates.pipe(
    Stream.runForEach((update) =>
      reconcile(update.instanceId, update.snapshot).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to reconcile HerdR snapshot into T3", {
            instanceId: update.instanceId,
            cause,
          }),
        ),
      ),
    ),
    Effect.forkScoped,
    Effect.asVoid,
  );

  return HerdrProjectionSync.of({ start });
});

export const HerdrProjectionSyncLive = Layer.effect(HerdrProjectionSync, make);
