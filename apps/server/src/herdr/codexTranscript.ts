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

const HERDR_DRIVER = ProviderDriverKind.make("herdr");

type CodexThread = CodexSchema.V2ThreadReadResponse["thread"];
type CodexTurn = CodexThread["turns"][number];
type CodexItem = CodexTurn["items"][number];

function isoFromUnixSeconds(value: number | null | undefined, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return Option.match(DateTime.make(value * 1_000), {
    onNone: () => fallback,
    onSome: DateTime.formatIso,
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
          data: item,
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

export function codexThreadRuntimeEvents(input: {
  readonly instanceId: ProviderInstanceId;
  readonly canonicalThreadId: ThreadId;
  readonly sessionId: string;
  readonly thread: CodexThread;
  readonly observedAt: string;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const events: ProviderRuntimeEvent[] = [];
  for (const turn of input.thread.turns) {
    const createdAt = isoFromUnixSeconds(turn.startedAt, input.observedAt);
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
    });

    for (const item of turn.items) {
      const event = itemEvent({ ...input, turn, item, createdAt });
      if (event) events.push(event);
    }

    if (turn.status !== "inProgress") {
      events.push({
        eventId: eventId(input.canonicalThreadId, input.sessionId, turn.id, "turn:completed"),
        provider: HERDR_DRIVER,
        providerInstanceId: input.instanceId,
        threadId: input.canonicalThreadId,
        turnId: canonicalTurnId,
        createdAt: isoFromUnixSeconds(turn.completedAt, input.observedAt),
        type: "turn.completed",
        payload: {
          state: turnState(turn.status),
          ...(turn.error?.message ? { errorMessage: turn.error.message } : {}),
        },
        providerRefs: { providerTurnId: turn.id },
      });
    }
  }
  return events;
}

export function runtimeEventFingerprint(event: ProviderRuntimeEvent): string {
  return JSON.stringify(event);
}
