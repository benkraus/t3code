import * as NodeNet from "node:net";
import * as NodeTimers from "node:timers";
import * as Schema from "effect/Schema";

const HerdrAgentStatusSchema = Schema.Literals(["idle", "working", "blocked", "done", "unknown"]);
export type HerdrAgentStatus = typeof HerdrAgentStatusSchema.Type;

const HerdrAgentSessionRefSchema = Schema.Struct({
  source: Schema.String,
  agent: Schema.String,
  kind: Schema.Literals(["id", "path"]),
  value: Schema.String,
});
export type HerdrAgentSessionRef = typeof HerdrAgentSessionRefSchema.Type;

const HerdrWireWorktreeSchema = Schema.Struct({
  repo_key: Schema.String,
  repo_name: Schema.String,
  repo_root: Schema.String,
  checkout_path: Schema.String,
  is_linked_worktree: Schema.Boolean,
});
export type HerdrWireWorktree = typeof HerdrWireWorktreeSchema.Type;

const HerdrWireWorkspaceSchema = Schema.Struct({
  workspace_id: Schema.String,
  number: Schema.Number,
  label: Schema.String,
  focused: Schema.Boolean,
  pane_count: Schema.Number,
  tab_count: Schema.Number,
  active_tab_id: Schema.String,
  agent_status: HerdrAgentStatusSchema,
  worktree: Schema.optionalKey(Schema.NullOr(HerdrWireWorktreeSchema)),
});
export type HerdrWireWorkspace = typeof HerdrWireWorkspaceSchema.Type;

const HerdrWireTabSchema = Schema.Struct({
  tab_id: Schema.String,
  workspace_id: Schema.String,
  number: Schema.Number,
  label: Schema.String,
  focused: Schema.Boolean,
  pane_count: Schema.Number,
  agent_status: HerdrAgentStatusSchema,
});
export type HerdrWireTab = typeof HerdrWireTabSchema.Type;

export const HerdrWirePaneSchema = Schema.Struct({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  workspace_id: Schema.String,
  tab_id: Schema.String,
  focused: Schema.Boolean,
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  foreground_cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  display_agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_status: HerdrAgentStatusSchema,
  agent_session: Schema.optionalKey(Schema.NullOr(HerdrAgentSessionRefSchema)),
  revision: Schema.Number,
  terminal_title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  terminal_title_stripped: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type HerdrWirePane = typeof HerdrWirePaneSchema.Type;

export const HerdrWireSnapshotSchema = Schema.Struct({
  version: Schema.String,
  protocol: Schema.Number,
  workspaces: Schema.Array(HerdrWireWorkspaceSchema),
  tabs: Schema.Array(HerdrWireTabSchema),
  panes: Schema.Array(HerdrWirePaneSchema),
  agents: Schema.Array(HerdrWirePaneSchema),
});
export type HerdrWireSnapshot = typeof HerdrWireSnapshotSchema.Type;

export const HerdrPaneReadSchema = Schema.Struct({
  pane_id: Schema.String,
  workspace_id: Schema.String,
  tab_id: Schema.String,
  text: Schema.String,
  revision: Schema.Number,
  truncated: Schema.Boolean,
});
export type HerdrPaneRead = typeof HerdrPaneReadSchema.Type;

const HerdrErrorReplySchema = Schema.Struct({
  id: Schema.String,
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});
const isHerdrErrorReply = Schema.is(HerdrErrorReplySchema);

const HerdrSuccessReplySchema = Schema.Struct({
  id: Schema.String,
  result: Schema.Unknown,
});
const isHerdrSuccessReply = Schema.is(HerdrSuccessReplySchema);

const decodeSnapshotResult = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("session_snapshot"),
    snapshot: HerdrWireSnapshotSchema,
  }),
);
const decodePaneReadResult = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("pane_read"),
    read: HerdrPaneReadSchema,
  }),
);
const decodeTabCreatedResult = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("tab_created"),
    tab: HerdrWireTabSchema,
    root_pane: HerdrWirePaneSchema,
  }),
);
const decodeAgentStartedResult = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("agent_started"),
    agent: HerdrWirePaneSchema,
    argv: Schema.Array(Schema.String),
  }),
);
const decodeOkResult = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("ok"),
  }),
);

let requestSequence = 0;

export class HerdrSocketRequestError extends Error {
  readonly operation: string;
  override readonly cause: unknown;

  constructor(operation: string, message: string, cause?: unknown) {
    super(`HerdR ${operation}: ${message}`);
    this.operation = operation;
    this.cause = cause;
  }
}

export class HerdrSocketClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 5_000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    decodeResult: (input: unknown) => T,
  ): Promise<T> {
    const id = `t3-herdr-${++requestSequence}`;
    return new Promise<T>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const socket = NodeNet.createConnection({ path: this.socketPath });
      socket.setEncoding("utf8");

      const settle = (effect: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        effect();
      };

      // @effect-diagnostics globalTimers:off
      const timeout = NodeTimers.setTimeout(
        () =>
          settle(() =>
            reject(new HerdrSocketRequestError(method, `timed out after ${this.timeoutMs}ms`)),
          ),
        this.timeoutMs,
      );

      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        settle(() => {
          try {
            const reply: unknown = JSON.parse(line);
            if (isHerdrErrorReply(reply)) {
              if (reply.id !== id) {
                reject(
                  new HerdrSocketRequestError(method, `received mismatched reply id '${reply.id}'`),
                );
                return;
              }
              reject(
                new HerdrSocketRequestError(method, `${reply.error.code}: ${reply.error.message}`),
              );
              return;
            }
            if (!isHerdrSuccessReply(reply)) {
              reject(new HerdrSocketRequestError(method, "returned an unexpected reply envelope"));
              return;
            }
            if (reply.id !== id) {
              reject(
                new HerdrSocketRequestError(method, `received mismatched reply id '${reply.id}'`),
              );
              return;
            }
            resolve(decodeResult(reply.result));
          } catch (cause) {
            reject(new HerdrSocketRequestError(method, "returned an invalid reply", cause));
          }
        });
      });
      socket.once("error", (cause) => {
        settle(() =>
          reject(
            new HerdrSocketRequestError(
              method,
              cause instanceof Error ? cause.message : "socket error",
              cause,
            ),
          ),
        );
      });
      socket.once("close", () => {
        settle(() => reject(new HerdrSocketRequestError(method, "connection closed before reply")));
      });
    });
  }

  async snapshot(): Promise<HerdrWireSnapshot> {
    const result = await this.request("session.snapshot", {}, decodeSnapshotResult);
    return result.snapshot;
  }

  async readPane(paneId: string, lines = 4_000): Promise<HerdrPaneRead> {
    const result = await this.request(
      "pane.read",
      {
        pane_id: paneId,
        source: "recent_unwrapped",
        format: "text",
        strip_ansi: true,
        lines,
      },
      decodePaneReadResult,
    );
    return result.read;
  }

  async submitAgent(target: string, text: string): Promise<void> {
    await this.sendInput(target, { text, keys: ["Enter"] });
  }

  async sendInput(paneId: string, input: { readonly text?: string; readonly keys?: string[] }) {
    await this.request(
      "pane.send_input",
      {
        pane_id: paneId,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.keys === undefined ? {} : { keys: input.keys }),
      },
      decodeOkResult,
    );
  }

  async closePane(paneId: string): Promise<void> {
    await this.request("pane.close", { pane_id: paneId }, decodeOkResult);
  }

  async createTab(input: {
    readonly workspaceId: string;
    readonly cwd: string;
    readonly label?: string;
  }): Promise<{ readonly tab: HerdrWireTab; readonly rootPane: HerdrWirePane }> {
    const result = await this.request(
      "tab.create",
      {
        workspace_id: input.workspaceId,
        cwd: input.cwd,
        ...(input.label === undefined ? {} : { label: input.label }),
        focus: false,
      },
      decodeTabCreatedResult,
    );
    return { tab: result.tab, rootPane: result.root_pane };
  }

  async startAgent(input: {
    readonly name: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly workspaceId: string;
    readonly tabId: string;
  }): Promise<HerdrWirePane> {
    const result = await this.request(
      "agent.start",
      {
        name: input.name,
        argv: input.argv,
        cwd: input.cwd,
        workspace_id: input.workspaceId,
        tab_id: input.tabId,
        focus: false,
      },
      decodeAgentStartedResult,
    );
    return result.agent;
  }
}
