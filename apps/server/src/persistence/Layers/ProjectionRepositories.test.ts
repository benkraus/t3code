import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { HerdrCodexThreadBindingRepositoryLive } from "./HerdrCodexThreadBindings.ts";
import { ProviderRuntimeEventReceiptRepositoryLive } from "./ProviderRuntimeEventReceipts.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { HerdrCodexThreadBindingRepository } from "../Services/HerdrCodexThreadBindings.ts";
import { ProviderRuntimeEventReceiptRepository } from "../Services/ProviderRuntimeEventReceipts.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    HerdrCodexThreadBindingRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProviderRuntimeEventReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("keeps thread freshness monotonic across ISO offsets", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const row = {
        threadId: ThreadId.make("thread-offset-order"),
        projectId: ProjectId.make("project-offset-order"),
        title: "Offset ordering",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T10:00:00+05:00",
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      };
      yield* threads.upsert(row);
      yield* threads.upsert({ ...row, updatedAt: "2026-04-01T06:00:00Z" });

      const persisted = yield* threads.getById({ threadId: row.threadId });
      assert.strictEqual(Option.getOrNull(persisted)?.updatedAt, "2026-04-01T06:00:00Z");
    }),
  );

  it.effect("deletes a provider runtime event receipt by provider and event id", () =>
    Effect.gen(function* () {
      const receipts = yield* ProviderRuntimeEventReceiptRepository;
      const provider = ProviderDriverKind.make("herdr");
      const eventId = EventId.make("herdr-codex:thread-1:session-1:turn-1:turn:completed");

      yield* receipts.upsert({
        provider,
        eventId,
        fingerprint: "completion-fingerprint",
        processedAt: "2026-07-20T00:00:00.000Z",
      });
      yield* receipts.deleteByEventId({ provider, eventId });

      assert.isTrue(Option.isNone(yield* receipts.get({ provider, eventId })));
    }),
  );

  it.effect("updates a HerdR Codex thread binding by canonical thread", () =>
    Effect.gen(function* () {
      const bindings = yield* HerdrCodexThreadBindingRepository;
      const threadId = ThreadId.make("herdr-thread-binding");

      yield* bindings.upsert({
        threadId,
        codexThreadId: "codex-root",
        codexSessionId: "codex-session-tree",
        reportedSessionId: "reported-root",
        eventNamespaceId: "reported-root",
        updatedAt: "2026-07-20T22:00:00.000Z",
      });
      yield* bindings.upsert({
        threadId,
        codexThreadId: "codex-fork",
        codexSessionId: "codex-session-tree",
        reportedSessionId: "reported-fork",
        eventNamespaceId: "reported-root",
        updatedAt: "2026-07-20T22:01:00.000Z",
      });

      assert.deepEqual(Option.getOrNull(yield* bindings.getByThreadId({ threadId })), {
        threadId,
        codexThreadId: "codex-fork",
        codexSessionId: "codex-session-tree",
        reportedSessionId: "reported-fork",
        eventNamespaceId: "reported-root",
        updatedAt: "2026-07-20T22:01:00.000Z",
      });
    }),
  );
});
