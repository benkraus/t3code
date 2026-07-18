import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type HerdrAgentStatus,
  type OrchestrationSessionStatus,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as HerdrEnvironmentRegistry from "./HerdrEnvironmentRegistry.ts";
import type { HerdrWirePane, HerdrWireSnapshot, HerdrWireWorkspace } from "./HerdrSocketClient.ts";
import { herdrProjectId, herdrThreadId } from "./identity.ts";

const HERDR_DRIVER = ProviderDriverKind.make("herdr");
const HERDR_MODEL = "herdr-managed";

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
    const workspaces = new Map(
      snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]),
    );
    const liveThreadIds = new Set<string>();

    for (const pane of snapshot.panes) {
      if (!pane.agent) continue;
      const workspace = workspaces.get(pane.workspace_id);
      if (!workspace) continue;
      const projectId = herdrProjectId(instanceId, workspace);
      const threadId = herdrThreadId(instanceId, pane);
      liveThreadIds.add(threadId);
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
      if (
        thread.session?.providerName !== HERDR_DRIVER ||
        thread.session.providerInstanceId !== instanceId ||
        liveThreadIds.has(thread.id) ||
        thread.session.status === "stopped"
      ) {
        continue;
      }
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
