// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { HerdrSocketClient, HerdrSocketRequestError } from "./HerdrSocketClient.ts";

interface RequestEnvelope {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startSocketServer(
  reply: (request: RequestEnvelope) => unknown,
): Promise<{ socketPath: string; requests: RequestEnvelope[] }> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-herdr-socket-"));
  const socketPath = NodePath.join(directory, "herdr.sock");
  const requests: RequestEnvelope[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as RequestEnvelope;
      requests.push(request);
      socket.end(`${JSON.stringify({ id: request.id, result: reply(request) })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          void NodeFSP.rm(directory, { recursive: true, force: true }).then(() => resolve());
        });
      }),
  );
  return { socketPath, requests };
}

const pane = {
  pane_id: "w1:p1",
  terminal_id: "term-1",
  workspace_id: "w1",
  tab_id: "w1:t1",
  focused: false,
  cwd: "/repo",
  foreground_cwd: "/repo",
  agent: "codex",
  agent_status: "idle",
  revision: 7,
};

const workspace = {
  workspace_id: "w1",
  number: 1,
  label: "repo",
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: "w1:t1",
  agent_status: "idle",
};

const tab = {
  tab_id: "w1:t1",
  workspace_id: "w1",
  number: 1,
  label: "1",
  focused: false,
  pane_count: 1,
  agent_status: "idle",
};

describe("HerdrSocketClient", () => {
  it("decodes live protocol replies and sends the expected parameters", async () => {
    const server = await startSocketServer((request) => {
      switch (request.method) {
        case "session.snapshot":
          return {
            type: "session_snapshot",
            snapshot: {
              version: "0.7.4",
              protocol: 16,
              workspaces: [workspace],
              tabs: [tab],
              panes: [pane],
              agents: [pane],
            },
          };
        case "pane.read":
          return {
            type: "pane_read",
            read: {
              pane_id: pane.pane_id,
              workspace_id: pane.workspace_id,
              tab_id: pane.tab_id,
              source: "recent_unwrapped",
              format: "text",
              text: "terminal output",
              revision: pane.revision,
              truncated: false,
            },
          };
        case "tab.create":
          return { type: "tab_created", tab, root_pane: pane };
        case "agent.start":
          return { type: "agent_started", agent: pane, argv: ["codex"] };
        default:
          return { type: "ok" };
      }
    });
    const client = new HerdrSocketClient(server.socketPath);

    await expect(client.snapshot()).resolves.toMatchObject({ protocol: 16, panes: [pane] });
    await expect(client.readPane(pane.pane_id)).resolves.toMatchObject({
      text: "terminal output",
      revision: 7,
    });
    await client.submitAgent(pane.pane_id, "hello");
    await client.sendInput(pane.pane_id, { keys: ["Ctrl-C"] });
    await expect(
      client.createTab({
        workspaceId: "w1",
        cwd: "/repo",
        label: "Mobile task",
      }),
    ).resolves.toMatchObject({ tab, rootPane: pane });
    await expect(
      client.startAgent({
        name: "codex",
        argv: ["codex"],
        cwd: "/repo",
        workspaceId: "w1",
        tabId: "w1:t1",
      }),
    ).resolves.toMatchObject(pane);

    expect(server.requests.map((request) => request.method)).toEqual([
      "session.snapshot",
      "pane.read",
      "pane.send_input",
      "pane.send_input",
      "tab.create",
      "agent.start",
    ]);
    expect(server.requests[1]?.params).toMatchObject({
      pane_id: pane.pane_id,
      source: "recent_unwrapped",
      format: "text",
      strip_ansi: true,
      lines: 4_000,
    });
    expect(server.requests[2]?.params).toEqual({
      pane_id: pane.pane_id,
      text: "hello",
      keys: ["Enter"],
    });
    expect(server.requests[4]?.params).toEqual({
      workspace_id: "w1",
      cwd: "/repo",
      label: "Mobile task",
      focus: false,
    });
    expect(server.requests[5]?.params).toEqual({
      name: "codex",
      argv: ["codex"],
      cwd: "/repo",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focus: false,
    });
  });

  it("rejects payloads that do not match the advertised method result", async () => {
    const server = await startSocketServer(() => ({
      type: "session_snapshot",
      snapshot: {
        version: "0.7.4",
        protocol: "sixteen",
        workspaces: [],
        tabs: [],
        panes: [],
        agents: [],
      },
    }));
    const client = new HerdrSocketClient(server.socketPath);

    await expect(client.snapshot()).rejects.toMatchObject({
      operation: "session.snapshot",
      message: expect.stringContaining("invalid reply"),
    } satisfies Partial<HerdrSocketRequestError>);
  });
});
