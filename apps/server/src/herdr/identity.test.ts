import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HerdrWirePane, HerdrWireWorkspace } from "./HerdrSocketClient.ts";
import { herdrLaunchName, herdrProjectId, herdrThreadId, splitCommand } from "./identity.ts";

const instanceId = ProviderInstanceId.make("herdr-personal");

function pane(overrides: Partial<HerdrWirePane> = {}): HerdrWirePane {
  return {
    pane_id: "w1:p1",
    terminal_id: "term-persistent",
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    agent: "codex",
    agent_status: "idle",
    revision: 1,
    ...overrides,
  };
}

function workspace(overrides: Partial<HerdrWireWorkspace> = {}): HerdrWireWorkspace {
  return {
    workspace_id: "w1",
    number: 1,
    label: "repo",
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: "w1:t1",
    agent_status: "idle",
    ...overrides,
  };
}

describe("HerdR identity", () => {
  it("keeps a thread id stable when a terminal moves to another pane", () => {
    const before = herdrThreadId(instanceId, pane());
    const after = herdrThreadId(
      instanceId,
      pane({ pane_id: "w9:p4", workspace_id: "w9", tab_id: "w9:t2" }),
    );

    expect(after).toBe(before);
  });

  it("separates identical terminal ids across provider instances", () => {
    expect(herdrThreadId(ProviderInstanceId.make("herdr-work"), pane())).not.toBe(
      herdrThreadId(instanceId, pane()),
    );
  });

  it("groups linked worktrees from the same repository into one project", () => {
    const first = workspace({
      workspace_id: "w1",
      worktree: {
        repo_key: "/repo/.git",
        repo_name: "repo",
        repo_root: "/repo",
        checkout_path: "/repo",
        is_linked_worktree: false,
      },
    });
    const linked = workspace({
      workspace_id: "w2",
      worktree: {
        repo_key: "/repo/.git",
        repo_name: "repo",
        repo_root: "/repo",
        checkout_path: "/worktrees/feature",
        is_linked_worktree: true,
      },
    });

    expect(herdrProjectId(instanceId, linked)).toBe(herdrProjectId(instanceId, first));
  });

  it("keeps unrelated workspaces without repository metadata separate", () => {
    expect(herdrProjectId(instanceId, workspace({ workspace_id: "w1" }))).not.toBe(
      herdrProjectId(instanceId, workspace({ workspace_id: "w2" })),
    );
  });
});

describe("splitCommand", () => {
  it("preserves quoted arguments", () => {
    expect(splitCommand(`codex --config 'approval_policy="never"' --name "Mobile agent"`)).toEqual([
      "codex",
      "--config",
      'approval_policy="never"',
      "--name",
      "Mobile agent",
    ]);
  });

  it("returns no argv entries for whitespace", () => {
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("herdrLaunchName", () => {
  it("creates a compact unique runtime label without changing the agent manifest", () => {
    expect(herdrLaunchName("codex", "term_656e84dab8d594f")).toBe("codex-t3-_656e84dab8d594f");
  });
});
