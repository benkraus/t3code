import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, expect, it } from "vite-plus/test";
import type { HerdrWirePane } from "./HerdrSocketClient.ts";

import {
  advanceCodexTranscriptStabilization,
  classifyCodexColdStartTurn,
  codexTranscriptPanePriority,
  codexThreadRuntimeEvents,
  codexTranscriptPaneSignature,
  resolveCodexExternallyActiveTurnId,
  runtimeEventFingerprint,
  selectCodexTranscriptEventsForPublication,
  staleCodexCompletionReceiptEventId,
  shouldRefreshCodexTranscript,
} from "./codexTranscript.ts";
import {
  codexLatestTurnSnapshotSignature,
  codexTranscriptSessionId,
  codexTranscriptReceiptNamespaces,
  codexTranscriptThreadId,
  codexTranscriptSnapshotSignature,
  codexTranscriptUserItemsSignature,
  mapCodexUserMessageCreatedAt,
  prioritizeCodexReasoningBackfill,
  recoverCodexTranscriptEventNamespace,
  resolveCodexTranscriptEventNamespace,
  resolveHerdrTranscriptStartedAtFallback,
  retainHerdrThreadState,
  retainHerdrTranscriptInFlightState,
  selectCodexBootstrapThread,
  selectCodexThreadForPane,
  shouldProbeReportedCodexThread,
  herdrAgentDisplayName,
  herdrProviderDisplayName,
} from "../provider/Drivers/HerdrDriver.ts";

const thread = {
  cliVersion: "0.142.2",
  createdAt: 1_784_400_000,
  cwd: "/tmp/project",
  ephemeral: false,
  id: "codex-session-1",
  modelProvider: "openai",
  preview: "Update the parser",
  sessionId: "codex-session-1",
  source: "cli",
  status: { type: "idle" },
  turns: [
    {
      id: "codex-turn-1",
      status: "completed",
      startedAt: 1_784_400_100,
      completedAt: 1_784_400_130,
      items: [
        {
          type: "userMessage",
          id: "user-item-1",
          content: [{ type: "text", text: "Update the parser" }],
        },
        {
          type: "commandExecution",
          id: "command-item-1",
          command: "vp test",
          commandActions: [],
          cwd: "/tmp/project",
          status: "completed",
          aggregatedOutput: "12 tests passed",
          exitCode: 0,
        },
        {
          type: "agentMessage",
          id: "assistant-item-1",
          text: "Implemented.\n\n```ts\nconst parsed = true;\n```",
          phase: "final_answer",
        },
      ],
    },
  ],
  updatedAt: 1_784_400_130,
} satisfies CodexSchema.V2ThreadReadResponse["thread"];

describe("Codex transcript identity", () => {
  it("presents the external runtime as Codex instead of HerdR", () => {
    expect(herdrProviderDisplayName(undefined)).toBe("Codex");
    expect(herdrProviderDisplayName("HerdR")).toBe("Codex");
    expect(herdrProviderDisplayName("  HerdR  ")).toBe("Codex");
    expect(herdrProviderDisplayName("Remote Codex")).toBe("Remote Codex");
    expect(herdrAgentDisplayName("codex")).toBe("Codex");
    expect(herdrAgentDisplayName("claude")).toBe("Claude");
    expect(herdrAgentDisplayName("custom-agent")).toBe("custom-agent");
  });

  it("separates resumable thread identity from the legacy event namespace", () => {
    const forkedThread = {
      ...thread,
      id: "forked-thread-id",
      sessionId: "shared-session-tree-id",
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(codexTranscriptThreadId(forkedThread)).toBe("forked-thread-id");
    expect(codexTranscriptSessionId(forkedThread)).toBe("shared-session-tree-id");
    const eventNamespaceId = resolveCodexTranscriptEventNamespace({
      binding: {
        threadId: ThreadId.make("herdr-thread-1"),
        codexThreadId: "previous-fork-id",
        codexSessionId: "shared-session-tree-id",
        reportedSessionId: "previous-reported-id",
        eventNamespaceId: "legacy-reported-id",
        updatedAt: "2026-07-20T22:00:00.000Z",
      },
      reportedSessionId: "new-reported-id",
      preserveBoundNamespace: true,
    });
    expect(eventNamespaceId).toBe("legacy-reported-id");
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: eventNamespaceId,
      thread: forkedThread,
      observedAt: "2026-07-20T22:00:00.000Z",
    });
    expect(events.every((event) => String(event.eventId).includes(":legacy-reported-id:"))).toBe(
      true,
    );
    expect(events.some((event) => String(event.eventId).includes(":forked-thread-id:"))).toBe(
      false,
    );

    expect(
      resolveCodexTranscriptEventNamespace({
        binding: {
          threadId: ThreadId.make("herdr-thread-1"),
          codexThreadId: "previous-fork-id",
          codexSessionId: "old-session-tree-id",
          reportedSessionId: "previous-reported-id",
          eventNamespaceId: "legacy-reported-id",
          updatedAt: "2026-07-20T22:00:00.000Z",
        },
        reportedSessionId: "new-reported-id",
        preserveBoundNamespace: false,
      }),
    ).toBe("new-reported-id");

    const rootThread = {
      ...thread,
      id: "root-thread-id",
      sessionId: "shared-session-tree-id",
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];
    expect(selectCodexThreadForPane(forkedThread, rootThread).id).toBe("root-thread-id");

    const newSessionThread = {
      ...thread,
      id: "new-root-thread-id",
      sessionId: "new-session-tree-id",
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];
    expect(selectCodexThreadForPane(forkedThread, newSessionThread).id).toBe("new-root-thread-id");

    expect(
      shouldProbeReportedCodexThread({
        boundThreadId: "previous-fork-id",
        recoveredThreadId: "previous-fork-id",
        reportedSessionId: "new-reported-id",
      }),
    ).toBe(true);
    expect(
      shouldProbeReportedCodexThread({
        boundThreadId: "previous-fork-id",
        recoveredThreadId: "new-reported-id",
        reportedSessionId: "new-reported-id",
      }),
    ).toBe(false);
  });

  it("recovers the pre-upgrade namespace by matching current transcript receipts", () => {
    const threadId = ThreadId.make("herdr-thread-1");
    const recoveredEventNamespaceId = recoverCodexTranscriptEventNamespace({
      threadId,
      thread,
      reportedSessionId: "new-reported-id",
      receipts: [
        {
          provider: ProviderDriverKind.make("herdr"),
          eventId: EventId.make(
            "herdr-codex:herdr-thread-1:legacy-reported-id:codex-turn-1:turn:started",
          ),
          fingerprint: "started",
          processedAt: "2026-07-20T22:00:00.000Z",
        },
        {
          provider: ProviderDriverKind.make("herdr"),
          eventId: EventId.make(
            "herdr-codex:herdr-thread-1:legacy-reported-id:codex-turn-1:item:assistant-item-1",
          ),
          fingerprint: "assistant",
          processedAt: "2026-07-20T22:00:01.000Z",
        },
        {
          provider: ProviderDriverKind.make("herdr"),
          eventId: EventId.make(
            "herdr-codex:herdr-thread-1:new-reported-id:codex-turn-1:turn:completed",
          ),
          fingerprint: "partial-current",
          processedAt: "2026-07-20T22:00:02.000Z",
        },
        {
          provider: ProviderDriverKind.make("herdr"),
          eventId: EventId.make(
            "herdr-codex:herdr-thread-1:unrelated-session:old-turn:turn:started",
          ),
          fingerprint: "old",
          processedAt: "2026-07-20T21:00:00.000Z",
        },
      ],
    });

    expect(recoveredEventNamespaceId).toBe("legacy-reported-id");
    if (recoveredEventNamespaceId === undefined) {
      throw new Error("Expected the legacy transcript namespace to be recovered.");
    }
    expect(
      resolveCodexTranscriptEventNamespace({
        binding: undefined,
        reportedSessionId: "new-reported-id",
        recoveredEventNamespaceId,
      }),
    ).toBe("legacy-reported-id");
  });

  it("selects a readable bootstrap thread by matching persisted receipt suffixes", () => {
    const threadId = ThreadId.make("herdr-thread-1");
    const receipts = [
      {
        provider: ProviderDriverKind.make("herdr"),
        eventId: EventId.make(
          "herdr-codex:herdr-thread-1:actual-rollout-id:codex-turn-1:turn:started",
        ),
        fingerprint: "started",
        processedAt: "2026-07-20T22:00:00.000Z",
      },
      {
        provider: ProviderDriverKind.make("herdr"),
        eventId: EventId.make(
          "herdr-codex:herdr-thread-1:actual-rollout-id:codex-turn-1:item:assistant-item-1",
        ),
        fingerprint: "assistant",
        processedAt: "2026-07-20T22:00:01.000Z",
      },
      {
        provider: ProviderDriverKind.make("herdr"),
        eventId: EventId.make("herdr-codex:herdr-thread-1:old-id:old-turn:turn:started"),
        fingerprint: "old",
        processedAt: "2026-07-20T21:00:00.000Z",
      },
    ];
    expect(codexTranscriptReceiptNamespaces({ threadId, receipts })).toEqual([
      "actual-rollout-id",
      "old-id",
    ]);
    expect(
      selectCodexBootstrapThread({
        threadId,
        receipts,
        candidates: [
          {
            namespaceId: "old-id",
            thread: {
              ...thread,
              id: "old-id",
              turns: [{ ...thread.turns[0]!, id: "old-turn" }],
              updatedAt: thread.updatedAt - 100,
            },
          },
          { namespaceId: "actual-rollout-id", thread },
        ],
      })?.id,
    ).toBe(thread.id);
    expect(
      selectCodexBootstrapThread({
        threadId,
        receipts,
        candidates: [{ namespaceId: "unmatched-readable-id", thread }],
      }),
    ).toBeUndefined();
  });

  it("changes the user-item cache signature only when transcript prompts change", () => {
    expect(codexTranscriptUserItemsSignature({ ...thread })).toBe(
      codexTranscriptUserItemsSignature(thread),
    );
    expect(
      codexTranscriptUserItemsSignature({
        ...thread,
        turns: [
          {
            ...thread.turns[0]!,
            items: [
              ...thread.turns[0]!.items,
              {
                type: "userMessage",
                id: "user-item-2",
                content: [{ type: "text", text: "Follow-up prompt" }],
              },
            ],
          },
        ],
      }),
    ).not.toBe(codexTranscriptUserItemsSignature(thread));
    expect(
      codexTranscriptUserItemsSignature({
        ...thread,
        turns: [{ ...thread.turns[0]!, startedAt: thread.turns[0]!.startedAt + 1 }],
      }),
    ).not.toBe(codexTranscriptUserItemsSignature(thread));
  });
});

describe("prioritizeCodexReasoningBackfill", () => {
  it("moves changed reasoning from the latest turn ahead of historical replay", () => {
    const event = (
      id: string,
      turnId: string,
      itemType: "reasoning" | "command_execution",
    ): ProviderRuntimeEvent => ({
      eventId: EventId.make(id),
      provider: ProviderDriverKind.make("herdr"),
      providerInstanceId: ProviderInstanceId.make("herdr"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make(turnId),
      createdAt: "2026-07-18T18:41:40.000Z",
      type: "item.completed",
      payload: { itemType, status: "completed" },
    });
    const historical = event("historical", "turn-old", "reasoning");
    const tool = event("tool", "turn-current", "command_execution");
    const current = event("current", "turn-current", "reasoning");

    expect(
      prioritizeCodexReasoningBackfill({
        events: [historical, tool, current],
        durableFingerprints: new Map([
          ["historical", "old-historical"],
          ["tool", runtimeEventFingerprint(tool)],
          ["current", "old-current"],
        ]),
        latestTurnId: TurnId.make("turn-current"),
      }).map((entry) => entry.eventId),
    ).toEqual(["current", "historical", "tool"]);
  });
});

describe("codexThreadRuntimeEvents", () => {
  it("maps persisted Codex turns into deterministic native runtime events", () => {
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
      userMessageCreatedAtByItemId: new Map([["user-item-1", "2026-07-18T18:41:40.500Z"]]),
    });

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "item.completed",
      "item.completed",
      "item.completed",
      "turn.completed",
    ]);
    const userEvent = events.find((event) => event.providerRefs?.providerItemId === "user-item-1");
    const commandEvent = events.find(
      (event) => event.providerRefs?.providerItemId === "command-item-1",
    );
    const assistantEvent = events.find(
      (event) => event.providerRefs?.providerItemId === "assistant-item-1",
    );
    expect(userEvent).toMatchObject({
      itemId: "herdr-codex:herdr-thread-1:codex-session-1:user-item-1",
      providerRefs: { providerItemId: "user-item-1" },
      payload: { itemType: "user_message", detail: "Update the parser" },
      createdAt: "2026-07-18T18:41:40.500Z",
    });
    expect(commandEvent).toMatchObject({
      itemId: "herdr-codex:herdr-thread-1:codex-session-1:command-item-1",
      payload: { itemType: "command_execution", detail: "vp test" },
      createdAt: "2026-07-18T18:41:40.501Z",
    });
    expect(assistantEvent).toMatchObject({
      itemId: "herdr-codex:herdr-thread-1:codex-session-1:assistant-item-1",
      payload: {
        itemType: "assistant_message",
        detail: "Implemented.\n\n```ts\nconst parsed = true;\n```",
      },
      createdAt: "2026-07-18T18:41:40.502Z",
    });
    expect(events.map((event) => Date.parse(event.createdAt))).toEqual(
      events.map((event) => Date.parse(event.createdAt)).toSorted((left, right) => left - right),
    );
    expect(
      events.every(
        (event, index) => index === 0 || event.createdAt !== events[index - 1]?.createdAt,
      ),
    ).toBe(true);
    expect(runtimeEventFingerprint(assistantEvent!)).toBe(runtimeEventFingerprint(assistantEvent!));
    expect(
      runtimeEventFingerprint({
        ...assistantEvent!,
        createdAt: "2026-07-19T10:00:00.000Z",
      }),
    ).not.toBe(runtimeEventFingerprint(assistantEvent!));
  });

  it("preserves a projected prompt timestamp when the turn starts later", () => {
    const promptCreatedAt = "2026-07-18T18:40:00.000Z";
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
      userMessageCreatedAtByItemId: new Map([["user-item-1", promptCreatedAt]]),
    });

    const turnStarted = events.find((event) => event.type === "turn.started");
    const userEvent = events.find((event) => event.providerRefs?.providerItemId === "user-item-1");
    const commandEvent = events.find(
      (event) => event.providerRefs?.providerItemId === "command-item-1",
    );

    expect(userEvent?.createdAt).toBe(promptCreatedAt);
    expect(Date.parse(userEvent!.createdAt)).toBeLessThan(Date.parse(turnStarted!.createdAt));
    expect(Date.parse(commandEvent!.createdAt)).toBeGreaterThan(Date.parse(turnStarted!.createdAt));
  });

  it("aligns transcript prompts and same-turn steers from the latest projected messages", () => {
    const steeredThread = {
      ...thread,
      turns: [
        {
          ...thread.turns[0]!,
          items: [
            thread.turns[0]!.items[0]!,
            {
              type: "userMessage",
              id: "user-steer-1",
              content: [{ type: "text", text: "Take a different approach" }],
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(
      mapCodexUserMessageCreatedAt({
        thread: steeredThread,
        projectedUserMessages: [
          { createdAt: "2026-07-18T18:41:40.500Z", text: "Update the parser" },
          { createdAt: "2026-07-18T18:41:45.750Z", text: "Take a different approach" },
        ],
      }),
    ).toEqual(
      new Map([
        ["user-item-1", "2026-07-18T18:41:40.500Z"],
        ["user-steer-1", "2026-07-18T18:41:45.750Z"],
      ]),
    );
  });

  it("matches attachment prompts against projected text without image placeholders", () => {
    const attachmentThread = {
      ...thread,
      turns: [
        {
          ...thread.turns[0]!,
          items: [
            {
              type: "userMessage",
              id: "user-with-image",
              content: [
                { type: "text", text: "Inspect this" },
                { type: "localImage", path: "/tmp/example.png" },
              ],
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(
      mapCodexUserMessageCreatedAt({
        thread: attachmentThread,
        projectedUserMessages: [{ createdAt: "2026-07-18T18:41:40.500Z", text: "Inspect this" }],
      }),
    ).toEqual(new Map([["user-with-image", "2026-07-18T18:41:40.500Z"]]));
  });

  it("preserves matched transcript history while ignoring an unmatched pending message", () => {
    expect(
      mapCodexUserMessageCreatedAt({
        thread,
        projectedUserMessages: [
          { createdAt: "2026-07-18T18:41:40.500Z", text: "Update the parser" },
          { createdAt: "2026-07-18T18:41:45.750Z", text: "Pending follow-up" },
        ],
      }),
    ).toEqual(new Map([["user-item-1", "2026-07-18T18:41:40.500Z"]]));
  });

  it("does not match an existing steer to a newer pending duplicate", () => {
    const steeredThread = {
      ...thread,
      turns: [
        {
          ...thread.turns[0]!,
          items: [
            thread.turns[0]!.items[0]!,
            {
              type: "userMessage",
              id: "user-steer-1",
              content: [{ type: "text", text: "Take a different approach" }],
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(
      mapCodexUserMessageCreatedAt({
        thread: steeredThread,
        projectedUserMessages: [
          { createdAt: "2026-07-18T18:41:40.500Z", text: "Update the parser" },
          { createdAt: "2026-07-18T18:41:45.750Z", text: "Take a different approach" },
          { createdAt: "2026-07-18T18:42:30.000Z", text: "Take a different approach" },
        ],
      }),
    ).toEqual(
      new Map([
        ["user-item-1", "2026-07-18T18:41:40.500Z"],
        ["user-steer-1", "2026-07-18T18:41:45.750Z"],
      ]),
    );
  });

  it("skips failed earlier messages and chooses the closest repeated prompt", () => {
    expect(
      mapCodexUserMessageCreatedAt({
        thread,
        projectedUserMessages: [
          { createdAt: "2026-07-18T18:00:00.000Z", text: "Update the parser" },
          { createdAt: "2026-07-18T18:20:00.000Z", text: "Unmirrored failed prompt" },
          { createdAt: "2026-07-18T18:41:40.500Z", text: "Update the parser" },
        ],
      }),
    ).toEqual(new Map([["user-item-1", "2026-07-18T18:41:40.500Z"]]));
  });

  it("ignores legacy transcript-imported duplicates when repairing prompt time", () => {
    expect(
      mapCodexUserMessageCreatedAt({
        thread,
        projectedUserMessages: [
          {
            messageId: "original-prompt",
            createdAt: "2026-07-18T18:40:00.000Z",
            text: "Update the parser",
          },
          {
            messageId: "user:herdr-codex:herdr-thread-1:codex-session-1:user-item-1",
            createdAt: "2026-07-18T18:41:40.001Z",
            text: "Update the parser",
          },
        ],
      }),
    ).toEqual(new Map([["user-item-1", "2026-07-18T18:40:00.000Z"]]));
  });

  it("prefers the pre-start prompt over a matching pending steer", () => {
    expect(
      mapCodexUserMessageCreatedAt({
        thread,
        projectedTurnPendingMessageIdById: new Map([["codex-turn-1", "original-prompt"]]),
        projectedUserMessages: [
          {
            messageId: "original-prompt",
            createdAt: "2026-07-18T18:41:39.500Z",
            text: "Update the parser",
          },
          {
            messageId: "pending-steer",
            createdAt: "2026-07-18T18:41:40.500Z",
            text: "Update the parser",
          },
        ],
      }),
    ).toEqual(new Map([["user-item-1", "2026-07-18T18:41:39.500Z"]]));
  });

  it("matches structured prompts after normalizing whitespace", () => {
    const structuredThread = {
      ...thread,
      turns: [
        {
          ...thread.turns[0]!,
          items: [
            {
              type: "userMessage",
              id: "structured-user-1",
              content: [
                { type: "text", text: "Use" },
                { type: "skill", name: "codex", path: "/tmp/codex/SKILL.md" },
                { type: "text", text: "now" },
              ],
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(
      mapCodexUserMessageCreatedAt({
        thread: structuredThread,
        projectedUserMessages: [{ createdAt: "2026-07-18T18:41:40.500Z", text: "Use $codex now" }],
      }),
    ).toEqual(new Map([["structured-user-1", "2026-07-18T18:41:40.500Z"]]));
  });

  it("uses the newest repeated prompt when turn timing is unavailable", () => {
    const timestampLessThread = {
      ...thread,
      turns: [{ ...thread.turns[0]!, startedAt: null }],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(
      mapCodexUserMessageCreatedAt({
        thread: timestampLessThread,
        projectedUserMessages: [
          { createdAt: "2026-07-18T18:00:00.000Z", text: "Update the parser" },
          { createdAt: "2026-07-18T18:41:40.500Z", text: "Update the parser" },
        ],
      }),
    ).toEqual(new Map([["user-item-1", "2026-07-18T18:41:40.500Z"]]));
  });

  it("orders projected prompts by timestamp instant before matching", () => {
    const twoTurnThread = {
      ...thread,
      turns: [
        thread.turns[0]!,
        {
          ...thread.turns[0]!,
          id: "codex-turn-2",
          startedAt: 1_784_400_200,
          items: [
            {
              type: "userMessage",
              id: "user-item-2",
              content: [{ type: "text", text: "Second prompt" }],
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(
      mapCodexUserMessageCreatedAt({
        thread: twoTurnThread,
        projectedUserMessages: [
          { createdAt: "2026-04-01T00:45:00+01:00", text: "Second prompt" },
          { createdAt: "2026-03-31T23:30:00Z", text: "Update the parser" },
        ],
      }),
    ).toEqual(
      new Map([
        ["user-item-1", "2026-03-31T23:30:00Z"],
        ["user-item-2", "2026-04-01T00:45:00+01:00"],
      ]),
    );
  });

  it("preserves repeated prompt sequence when timing is unavailable", () => {
    const repeatedThread = {
      ...thread,
      turns: [
        {
          ...thread.turns[0]!,
          startedAt: null,
          items: [
            {
              type: "userMessage",
              id: "user-a-1",
              content: [{ type: "text", text: "A" }],
            },
            {
              type: "userMessage",
              id: "user-b-1",
              content: [{ type: "text", text: "B" }],
            },
            {
              type: "userMessage",
              id: "user-a-2",
              content: [{ type: "text", text: "A" }],
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    expect(
      mapCodexUserMessageCreatedAt({
        thread: repeatedThread,
        projectedUserMessages: [
          { createdAt: "2026-07-18T18:41:40.100Z", text: "A" },
          { createdAt: "2026-07-18T18:41:40.200Z", text: "B" },
          { createdAt: "2026-07-18T18:41:40.300Z", text: "A" },
        ],
      }),
    ).toEqual(
      new Map([
        ["user-a-1", "2026-07-18T18:41:40.100Z"],
        ["user-b-1", "2026-07-18T18:41:40.200Z"],
        ["user-a-2", "2026-07-18T18:41:40.300Z"],
      ]),
    );
  });

  it("invalidates transcript caching when projected prompt timestamps change", () => {
    const pane = {
      agent_status: "done",
      revision: 1,
      agent_session: { agent: "codex", kind: "id", value: thread.sessionId },
    } as HerdrWirePane;
    const withoutTimestamp = codexTranscriptSnapshotSignature({
      pane,
      thread,
      userMessageCreatedAtByItemId: new Map(),
    });
    const withTimestamp = codexTranscriptSnapshotSignature({
      pane,
      thread,
      userMessageCreatedAtByItemId: new Map([["user-item-1", "2026-07-18T18:41:40.500Z"]]),
    });

    expect(withTimestamp).not.toBe(withoutTimestamp);
  });

  it("uses stable timestamp fallbacks and detects later authoritative turn times", () => {
    const missingTimestampThread = {
      ...thread,
      turns: [{ ...thread.turns[0]!, startedAt: null, completedAt: null }],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];
    const fallbackStartedAtByTurnId = new Map([["codex-turn-1", "2026-07-18T20:00:00.000Z"]]);
    const first = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: missingTimestampThread,
      observedAt: "2026-07-18T20:00:00.000Z",
      externallyActiveTurnId: TurnId.make("codex-turn-1"),
      fallbackStartedAtByTurnId,
    });
    const second = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: missingTimestampThread,
      observedAt: "2026-07-19T20:00:00.000Z",
      externallyActiveTurnId: TurnId.make("codex-turn-1"),
      fallbackStartedAtByTurnId,
    });
    const authoritative = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: {
        ...missingTimestampThread,
        turns: [{ ...missingTimestampThread.turns[0]!, startedAt: 1_784_400_100 }],
      },
      observedAt: "2026-07-19T20:00:00.000Z",
      externallyActiveTurnId: TurnId.make("codex-turn-1"),
      fallbackStartedAtByTurnId,
    });

    expect(first[0]?.createdAt).toBe("2026-07-18T20:00:00.000Z");
    expect(first[0]?.createdAt).toBe(second[0]?.createdAt);
    expect(runtimeEventFingerprint(first[0]!)).toBe(runtimeEventFingerprint(second[0]!));
    expect(runtimeEventFingerprint(authoritative[0]!)).not.toBe(runtimeEventFingerprint(first[0]!));
  });

  it("keeps missing turn starts after the preceding authoritative turn", () => {
    const mixedTimestampThread = {
      ...thread,
      turns: [
        { ...thread.turns[0]!, id: "turn-authoritative", startedAt: 1_784_400_100 },
        { ...thread.turns[0]!, id: "turn-missing", startedAt: null },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: mixedTimestampThread,
      observedAt: "2026-07-20T00:00:00.000Z",
    });
    const starts = events.filter((event) => event.type === "turn.started");

    expect(Date.parse(starts[1]!.createdAt)).toBeGreaterThan(Date.parse(starts[0]!.createdAt));
  });

  it("uses the persisted duration when a terminal turn omits completedAt", () => {
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: {
        ...thread,
        turns: [{ ...thread.turns[0]!, completedAt: null, durationMs: 2_500 }],
      },
      observedAt: "2026-07-18T20:00:00.000Z",
    });

    expect(events.find((event) => event.type === "turn.completed")?.createdAt).toBe(
      "2026-07-18T18:41:42.500Z",
    );
  });

  it("does not add a historical duration to a first-observed start fallback", () => {
    const observedAt = "2026-07-20T04:00:00.000Z";
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: {
        ...thread,
        turns: [
          {
            ...thread.turns[0]!,
            startedAt: null,
            completedAt: null,
            durationMs: 3_600_000,
          },
        ],
      },
      observedAt,
      fallbackStartedAtByTurnId: new Map([["codex-turn-1", observedAt]]),
      fallbackCompletedAtByTurnId: new Map([["codex-turn-1", observedAt]]),
    });

    expect(events.find((event) => event.type === "turn.completed")?.createdAt).toBe(
      "2026-07-20T04:00:00.004Z",
    );
  });

  it("keeps a first-observed completion fallback stable across thread metadata updates", () => {
    const fallbackCompletedAtByTurnId = new Map([["codex-turn-1", "2026-07-18T20:00:00.000Z"]]);
    const missingCompletion = {
      ...thread,
      turns: [{ ...thread.turns[0]!, completedAt: null }],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];
    const first = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: missingCompletion,
      observedAt: "2026-07-18T20:00:00.000Z",
      fallbackCompletedAtByTurnId,
    });
    const afterMetadataUpdate = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: { ...missingCompletion, updatedAt: 1_784_500_000 },
      observedAt: "2026-07-19T20:00:00.000Z",
      fallbackCompletedAtByTurnId,
    });

    expect(first.find((event) => event.type === "turn.completed")?.createdAt).toBe(
      "2026-07-18T20:00:00.000Z",
    );
    expect(runtimeEventFingerprint(first.at(-1)!)).toBe(
      runtimeEventFingerprint(afterMetadataUpdate.at(-1)!),
    );
  });

  it("republishes terminal lifecycle events atomically when only the start changes", () => {
    const missingStartThread = {
      ...thread,
      turns: [{ ...thread.turns[0]!, startedAt: null }],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];
    const initialEvents = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread: missingStartThread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });
    const authoritativeEvents = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread,
      observedAt: "2026-07-19T20:00:00.000Z",
    });
    const durableFingerprints = new Map(
      initialEvents.map((event) => [event.eventId, runtimeEventFingerprint(event)] as const),
    );

    const authoritativeLifecycleEvents = authoritativeEvents.filter(
      (event) => event.type === "turn.started" || event.type === "turn.completed",
    );
    const selected = selectCodexTranscriptEventsForPublication({
      events: authoritativeLifecycleEvents,
      durableFingerprints,
      inFlight: new Map(),
      emittedAtMs: 10_000,
      retryAfterMs: 60_000,
    });

    expect(runtimeEventFingerprint(authoritativeLifecycleEvents[1]!)).not.toBe(
      durableFingerprints.get(authoritativeLifecycleEvents[1]!.eventId),
    );
    expect(authoritativeLifecycleEvents[0]?.raw?.payload).toMatchObject({ terminal: true });
    expect(authoritativeLifecycleEvents[1]?.raw?.payload).toMatchObject({ terminal: true });
    expect(selected.events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(selected.inFlight.get(authoritativeLifecycleEvents[0]!.eventId)?.fingerprint).toBe(
      runtimeEventFingerprint(authoritativeLifecycleEvents[0]!),
    );
    expect(selected.inFlight.get(authoritativeLifecycleEvents[1]!.eventId)?.fingerprint).toBe(
      runtimeEventFingerprint(authoritativeLifecycleEvents[1]!),
    );

    const retried = selectCodexTranscriptEventsForPublication({
      events: authoritativeLifecycleEvents,
      durableFingerprints,
      inFlight: selected.inFlight,
      emittedAtMs: 70_000,
      retryAfterMs: 60_000,
    });
    expect(retried.events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
  });

  it("preserves per-turn causal order while selecting changed snapshot events", () => {
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });
    const selected = selectCodexTranscriptEventsForPublication({
      events,
      durableFingerprints: new Map(),
      inFlight: new Map(),
      emittedAtMs: 10_000,
      retryAfterMs: 60_000,
    });

    expect(selected.events.map((event) => event.type)).toEqual(events.map((event) => event.type));
  });

  it("bounds and backs off retries for unacknowledged transcript events", () => {
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
    }).filter((event) => event.type === "item.completed");
    const initial = selectCodexTranscriptEventsForPublication({
      events,
      durableFingerprints: new Map(),
      inFlight: new Map(),
      emittedAtMs: 0,
      retryAfterMs: 5_000,
      maxRetryAfterMs: 60_000,
      maxRetryExponent: 1,
      maxRetryEvents: 1,
    });
    const firstRetry = selectCodexTranscriptEventsForPublication({
      events,
      durableFingerprints: new Map(),
      inFlight: initial.inFlight,
      emittedAtMs: 5_000,
      retryAfterMs: 5_000,
      maxRetryAfterMs: 60_000,
      maxRetryExponent: 1,
      maxRetryEvents: 1,
    });
    const backedOff = selectCodexTranscriptEventsForPublication({
      events: firstRetry.events,
      durableFingerprints: new Map(),
      inFlight: firstRetry.inFlight,
      emittedAtMs: 10_000,
      retryAfterMs: 5_000,
      maxRetryAfterMs: 60_000,
      maxRetryExponent: 1,
      maxRetryEvents: 1,
    });
    const laterRetry = selectCodexTranscriptEventsForPublication({
      events: firstRetry.events,
      durableFingerprints: new Map(),
      inFlight: firstRetry.inFlight,
      emittedAtMs: 15_000,
      retryAfterMs: 5_000,
      maxRetryAfterMs: 60_000,
      maxRetryExponent: 1,
      maxRetryEvents: 1,
    });

    expect(firstRetry.events).toHaveLength(1);
    expect(firstRetry.inFlight.get(firstRetry.events[0]!.eventId)?.retryCount).toBe(1);
    expect(backedOff.events).toHaveLength(0);
    expect(laterRetry.events).toHaveLength(1);
    expect(laterRetry.inFlight.get(laterRetry.events[0]!.eventId)?.retryCount).toBe(1);
  });

  it("prunes in-flight events that disappear from the current thread snapshot", () => {
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });
    const initial = selectCodexTranscriptEventsForPublication({
      events,
      durableFingerprints: new Map(),
      inFlight: new Map(),
      emittedAtMs: 0,
      retryAfterMs: 5_000,
      eventIdPrefix: "herdr-codex:herdr-thread-1:codex-session-1:",
    });
    const removedEvent = events.find((event) => event.type === "item.completed")!;
    const pruned = selectCodexTranscriptEventsForPublication({
      events: events.filter((event) => event.eventId !== removedEvent.eventId),
      durableFingerprints: new Map(),
      inFlight: initial.inFlight,
      emittedAtMs: 1_000,
      retryAfterMs: 5_000,
      eventIdPrefix: "herdr-codex:herdr-thread-1:codex-session-1:",
    });

    expect(pruned.inFlight.has(removedEvent.eventId)).toBe(false);
  });

  it("scopes runtime event and item ids to the canonical thread", () => {
    const first = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: "codex-session-1",
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });
    const second = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-2"),
      sessionId: "codex-session-1",
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });

    const firstItem = first.find((event) => event.providerRefs?.providerItemId === "user-item-1");
    const secondItem = second.find((event) => event.providerRefs?.providerItemId === "user-item-1");
    expect(firstItem?.providerRefs?.providerItemId).toBe(secondItem?.providerRefs?.providerItemId);
    expect(firstItem?.eventId).not.toBe(secondItem?.eventId);
    expect(firstItem?.itemId).not.toBe(secondItem?.itemId);
  });

  it("preserves MCP tool data in the canonical nested item payload", () => {
    const mcpItem = {
      type: "mcpToolCall" as const,
      id: "mcp-item-1",
      server: "expect",
      tool: "screenshot",
      arguments: { viewport: "mobile" },
      durationMs: 15,
      error: null,
      result: { content: [{ type: "text", text: "captured" }] },
      status: "completed" as const,
    };
    const mcpThread = {
      ...thread,
      turns: [
        {
          id: "codex-turn-1",
          status: "completed",
          startedAt: 1_784_400_100,
          completedAt: 1_784_400_130,
          items: [mcpItem],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: mcpThread.sessionId,
      thread: mcpThread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });

    expect(
      events.find((event) => event.providerRefs?.providerItemId === "mcp-item-1"),
    ).toMatchObject({
      payload: {
        itemType: "mcp_tool_call",
        title: "expect · screenshot",
        data: { item: mcpItem },
      },
    });
  });

  it("keeps the latest incomplete turn active when HerdR reports live work", () => {
    const activeThread = {
      ...thread,
      turns: [
        {
          id: "codex-turn-live",
          status: "interrupted",
          startedAt: 1_784_400_200,
          completedAt: null,
          items: [
            {
              type: "agentMessage",
              id: "assistant-live",
              text: "Still working.",
              phase: "commentary",
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: activeThread.sessionId,
      thread: activeThread,
      observedAt: "2026-07-18T20:00:00.000Z",
      externallyActiveTurnId: TurnId.make("codex-turn-live"),
    });

    expect(events.map((event) => event.type)).toEqual(["turn.started", "item.completed"]);
  });

  it("preserves every turn lifecycle in chronological causal order", () => {
    const multiTurnThread = {
      ...thread,
      turns: [
        thread.turns[0]!,
        {
          id: "codex-turn-live",
          status: "interrupted",
          startedAt: 1_784_400_200,
          completedAt: null,
          items: [
            {
              type: "agentMessage",
              id: "assistant-live",
              text: "Newest commentary.",
              phase: "commentary",
            },
          ],
        },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];

    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: multiTurnThread.sessionId,
      thread: multiTurnThread,
      observedAt: "2026-07-18T20:00:00.000Z",
      externallyActiveTurnId: TurnId.make("codex-turn-live"),
    });

    const latestItemEvent = events.findLast((event) => event.type === "item.completed");
    expect(latestItemEvent).toMatchObject({
      turnId: "codex-turn-live",
      payload: { itemType: "reasoning", detail: "Newest commentary." },
    });
    expect(
      events.filter((event) => event.turnId === "codex-turn-1" && event.type.startsWith("turn.")),
    ).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      turnId: "codex-turn-live",
      payload: { itemType: "reasoning", detail: "Newest commentary." },
    });
  });

  it("keeps timestamp-less turns in stable chronological order", () => {
    const timestampLessThread = {
      ...thread,
      turns: [
        { ...thread.turns[0]!, id: "turn-without-time-1", startedAt: null },
        { ...thread.turns[0]!, id: "turn-without-time-2", startedAt: null },
      ],
    } satisfies CodexSchema.V2ThreadReadResponse["thread"];
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: timestampLessThread.sessionId,
      thread: timestampLessThread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });
    const starts = events.filter((event) => event.type === "turn.started");

    expect(starts[0]?.createdAt).toBe("2026-07-18T18:40:00.000Z");
    expect(starts[1]?.createdAt).toBe("2026-07-18T18:42:10.001Z");
  });
});

describe("shouldRefreshCodexTranscript", () => {
  const pane = {
    agent_session: {
      source: "herdr:codex",
      agent: "codex",
      kind: "id" as const,
      value: "codex-session-1",
    },
    revision: 4,
  };

  it("continues polling an active pane when its HerdR signature is unchanged", () => {
    const workingPane = { ...pane, agent_status: "working" as const };

    expect(
      shouldRefreshCodexTranscript(
        workingPane,
        codexTranscriptPaneSignature(workingPane),
        codexTranscriptPaneSignature(workingPane),
        1_000,
        6_000,
      ),
    ).toBe(true);
  });

  it("prioritizes active panes ahead of idle transcript imports", () => {
    expect(codexTranscriptPanePriority({ agent_status: "working" })).toBe(0);
    expect(codexTranscriptPanePriority({ agent_status: "blocked" })).toBe(0);
    expect(codexTranscriptPanePriority({ agent_status: "idle" })).toBe(1);
    expect(codexTranscriptPanePriority({ agent_status: "done" })).toBe(1);
  });

  it("throttles active pane refreshes inside the live polling interval", () => {
    const workingPane = { ...pane, agent_status: "working" as const };

    expect(
      shouldRefreshCodexTranscript(
        workingPane,
        codexTranscriptPaneSignature(workingPane),
        codexTranscriptPaneSignature(workingPane),
        1_500,
        3_000,
      ),
    ).toBe(false);
  });

  it("deduplicates unchanged idle panes", () => {
    const idlePane = { ...pane, agent_status: "idle" as const };

    expect(
      shouldRefreshCodexTranscript(
        idlePane,
        codexTranscriptPaneSignature(idlePane),
        codexTranscriptPaneSignature(idlePane),
        undefined,
        3_000,
      ),
    ).toBe(false);
  });

  it("backs off a failed idle pane until the retry interval elapses", () => {
    const idlePane = { ...pane, agent_status: "idle" as const };
    const signature = codexTranscriptPaneSignature(idlePane);
    expect(shouldRefreshCodexTranscript(idlePane, undefined, signature, 1_000, 5_000)).toBe(false);
    expect(shouldRefreshCodexTranscript(idlePane, undefined, signature, 1_000, 31_000)).toBe(true);
  });

  it("polls a successfully read idle pane until its transcript snapshot stabilizes", () => {
    const idlePane = { ...pane, agent_status: "idle" as const };
    const signature = codexTranscriptPaneSignature(idlePane);

    expect(shouldRefreshCodexTranscript(idlePane, undefined, signature, 1_000, 6_000, true)).toBe(
      true,
    );
  });

  it("retries an idle pane immediately when its signature changes", () => {
    const idlePane = { ...pane, agent_status: "idle" as const };

    expect(
      shouldRefreshCodexTranscript(idlePane, undefined, "codex-session-1:3:idle", 1_000, 5_000),
    ).toBe(true);
  });
});

describe("advanceCodexTranscriptStabilization", () => {
  it("requires two matching idle snapshots before settling the pane", () => {
    const first = advanceCodexTranscriptStabilization({
      candidate: undefined,
      paneSignature: "codex-session-1:4:idle",
      snapshotSignature: "snapshot-before-final-answer",
      hasPendingEvents: false,
      hasActiveTurn: false,
    });
    expect(first.settled).toBe(false);

    const changed = advanceCodexTranscriptStabilization({
      candidate: first.candidate,
      paneSignature: "codex-session-1:4:idle",
      snapshotSignature: "snapshot-with-final-answer",
      hasPendingEvents: false,
      hasActiveTurn: false,
    });
    expect(changed.settled).toBe(false);

    const stable = advanceCodexTranscriptStabilization({
      candidate: changed.candidate,
      paneSignature: "codex-session-1:4:idle",
      snapshotSignature: "snapshot-with-final-answer",
      hasPendingEvents: false,
      hasActiveTurn: false,
    });
    expect(stable).toEqual({ candidate: undefined, settled: true });
  });

  it("does not settle while matching transcript events remain in flight", () => {
    const candidate = {
      paneSignature: "codex-session-1:4:idle",
      snapshotSignature: "snapshot-with-final-answer",
    };
    expect(
      advanceCodexTranscriptStabilization({
        candidate,
        paneSignature: candidate.paneSignature,
        snapshotSignature: candidate.snapshotSignature,
        hasPendingEvents: true,
        hasActiveTurn: false,
      }),
    ).toEqual({ candidate, settled: false });
  });

  it("does not settle an idle pane while the snapshot still has an active turn", () => {
    const candidate = {
      paneSignature: "codex-session-1:4:idle",
      snapshotSignature: "active-snapshot",
    };
    expect(
      advanceCodexTranscriptStabilization({
        candidate,
        paneSignature: candidate.paneSignature,
        snapshotSignature: candidate.snapshotSignature,
        hasPendingEvents: false,
        hasActiveTurn: true,
      }),
    ).toEqual({ candidate, settled: false });
  });
});

describe("resolveCodexExternallyActiveTurnId", () => {
  const interruptedThread = {
    ...thread,
    turns: [
      {
        ...thread.turns[0]!,
        id: "codex-turn-interrupted",
        status: "interrupted" as const,
        completedAt: null,
      },
    ],
  } satisfies CodexSchema.V2ThreadReadResponse["thread"];

  it("does not revive a previously observed historical turn when the pane starts working", () => {
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: interruptedThread,
        externallyActive: true,
        latestTurnHasDurableCompletion: false,
        previousLatestTurnId: TurnId.make("codex-turn-interrupted"),
      }),
    ).toBeUndefined();
  });

  it("accepts a new, already-active, or app-server in-progress latest turn", () => {
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: interruptedThread,
        externallyActive: true,
        latestTurnHasDurableCompletion: false,
        previousLatestTurnId: TurnId.make("older-turn"),
      }),
    ).toBe("codex-turn-interrupted");
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: interruptedThread,
        externallyActive: true,
        latestTurnHasDurableCompletion: false,
        previousLatestTurnId: TurnId.make("codex-turn-interrupted"),
        activeTurnId: TurnId.make("codex-turn-interrupted"),
      }),
    ).toBe("codex-turn-interrupted");
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: {
          ...interruptedThread,
          turns: [{ ...interruptedThread.turns[0]!, status: "inProgress" }],
        },
        externallyActive: true,
        latestTurnHasDurableCompletion: true,
        previousLatestTurnId: TurnId.make("codex-turn-interrupted"),
      }),
    ).toBe("codex-turn-interrupted");
  });

  it("keeps a newly discovered sent turn active before HerdR reports working", () => {
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: interruptedThread,
        externallyActive: false,
        forcedActiveTurnId: TurnId.make("codex-turn-interrupted"),
        latestTurnHasDurableCompletion: false,
      }),
    ).toBe("codex-turn-interrupted");
  });

  it("accepts an app-server in-progress turn before HerdR status catches up", () => {
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: {
          ...interruptedThread,
          turns: [{ ...interruptedThread.turns[0]!, status: "inProgress" }],
        },
        externallyActive: false,
        latestTurnHasDurableCompletion: false,
      }),
    ).toBe("codex-turn-interrupted");
  });

  it("does not revive a first snapshot with a durable completion receipt", () => {
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: interruptedThread,
        externallyActive: true,
        latestTurnHasDurableCompletion: true,
      }),
    ).toBeUndefined();
  });

  it("treats an omitted completion timestamp as incomplete", () => {
    const { completedAt: _completedAt, ...turnWithoutCompletedAt } = interruptedThread.turns[0]!;
    expect(
      resolveCodexExternallyActiveTurnId({
        thread: {
          ...interruptedThread,
          turns: [turnWithoutCompletedAt],
        },
        externallyActive: true,
        latestTurnHasDurableCompletion: false,
      }),
    ).toBe("codex-turn-interrupted");
  });
});

describe("staleCodexCompletionReceiptEventId", () => {
  const eventIdPrefix = "herdr-codex:thread-1:session-1:";
  const turnId = TurnId.make("codex-turn-reopened");
  const completionEventId = `${eventIdPrefix}${turnId}:turn:completed`;

  it("invalidates a durable completion when the same projected turn is running", () => {
    expect(
      staleCodexCompletionReceiptEventId({
        eventIdPrefix,
        latestTurnId: turnId,
        projectedLatestTurnState: "running",
        durableFingerprints: new Map([[completionEventId, "old-completion"]]),
      }),
    ).toBe(completionEventId);
  });

  it("keeps terminal or absent completion receipts", () => {
    expect(
      staleCodexCompletionReceiptEventId({
        eventIdPrefix,
        latestTurnId: turnId,
        projectedLatestTurnState: "completed",
        durableFingerprints: new Map([[completionEventId, "completion"]]),
      }),
    ).toBeUndefined();
    expect(
      staleCodexCompletionReceiptEventId({
        eventIdPrefix,
        latestTurnId: turnId,
        projectedLatestTurnState: "running",
        durableFingerprints: new Map(),
      }),
    ).toBeUndefined();
  });
});

describe("classifyCodexColdStartTurn", () => {
  it("defers a terminal projection until the same provider turn shows progress", () => {
    const first = classifyCodexColdStartTurn({
      candidate: undefined,
      turnId: TurnId.make("codex-turn-interrupted"),
      snapshotSignature: "snapshot-1",
      projectedTerminal: true,
      hasDurableCompletion: false,
    });
    expect(first.defer).toBe(true);

    const unchanged = classifyCodexColdStartTurn({
      candidate: first.candidate,
      turnId: TurnId.make("codex-turn-interrupted"),
      snapshotSignature: "snapshot-1",
      projectedTerminal: true,
      hasDurableCompletion: false,
    });
    expect(unchanged.defer).toBe(true);

    const progressed = classifyCodexColdStartTurn({
      candidate: unchanged.candidate,
      turnId: TurnId.make("codex-turn-interrupted"),
      snapshotSignature: "snapshot-2",
      projectedTerminal: true,
      hasDurableCompletion: false,
    });
    expect(progressed).toEqual({ candidate: undefined, defer: false });
  });
});

describe("HerdR transcript driver state", () => {
  it("scopes cold-start progress signatures to the latest turn", () => {
    const latestTurn = thread.turns[0]!;
    expect(codexLatestTurnSnapshotSignature(latestTurn)).toBe(
      codexLatestTurnSnapshotSignature({ ...latestTurn }),
    );
    expect(codexLatestTurnSnapshotSignature(latestTurn)).not.toBe(
      codexLatestTurnSnapshotSignature({
        ...latestTurn,
        items: [...latestTurn.items, { type: "agentMessage", id: "new-item", text: "Progress" }],
      }),
    );
  });

  it("uses a stable first-observed start for every timestamp-less turn", () => {
    expect(
      resolveHerdrTranscriptStartedAtFallback({
        projectedStartedAt: null,
        cachedStartedAt: undefined,
        observedAt: "2026-07-20T04:00:00.000Z",
      }),
    ).toBe("2026-07-20T04:00:00.000Z");
    expect(
      resolveHerdrTranscriptStartedAtFallback({
        projectedStartedAt: null,
        cachedStartedAt: "2026-07-20T04:00:00.000Z",
        observedAt: "2026-07-20T05:00:00.000Z",
      }),
    ).toBe("2026-07-20T04:00:00.000Z");
  });

  it("prunes thread and in-flight state for panes missing from a full snapshot", () => {
    const retainedThreadId = ThreadId.make("herdr-thread-retained");
    const removedThreadId = ThreadId.make("herdr-thread-removed");
    const retainedThreadIds = new Set<string>([retainedThreadId]);

    expect(
      Array.from(
        retainHerdrThreadState(
          new Map([
            [retainedThreadId, "retained"],
            [removedThreadId, "removed"],
          ]),
          retainedThreadIds,
        ),
      ),
    ).toEqual([[retainedThreadId, "retained"]]);
    expect(
      Array.from(
        retainHerdrTranscriptInFlightState(
          new Map([
            [`herdr-codex:${retainedThreadId}:session:turn:item`, "retained"],
            [`herdr-codex:${removedThreadId}:session:turn:item`, "removed"],
          ]),
          retainedThreadIds,
        ),
      ),
    ).toEqual([[`herdr-codex:${retainedThreadId}:session:turn:item`, "retained"]]);
  });
});
