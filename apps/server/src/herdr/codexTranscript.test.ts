import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, expect, it } from "vite-plus/test";

import { codexThreadRuntimeEvents, runtimeEventFingerprint } from "./codexTranscript.ts";

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

describe("codexThreadRuntimeEvents", () => {
  it("maps persisted Codex turns into deterministic native runtime events", () => {
    const events = codexThreadRuntimeEvents({
      instanceId: ProviderInstanceId.make("herdr"),
      canonicalThreadId: ThreadId.make("herdr-thread-1"),
      sessionId: thread.sessionId,
      thread,
      observedAt: "2026-07-18T20:00:00.000Z",
    });

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "item.completed",
      "item.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(events[1]).toMatchObject({
      itemId: "user-item-1",
      payload: { itemType: "user_message", detail: "Update the parser" },
    });
    expect(events[2]).toMatchObject({
      itemId: "command-item-1",
      payload: { itemType: "command_execution", detail: "vp test" },
    });
    expect(events[3]).toMatchObject({
      itemId: "assistant-item-1",
      payload: {
        itemType: "assistant_message",
        detail: "Implemented.\n\n```ts\nconst parsed = true;\n```",
      },
    });
    expect(runtimeEventFingerprint(events[3]!)).toBe(runtimeEventFingerprint(events[3]!));
  });
});
