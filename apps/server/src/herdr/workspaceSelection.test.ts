import { describe, expect, it } from "vite-plus/test";

import type { HerdrWirePane, HerdrWireSnapshot, HerdrWireWorkspace } from "./HerdrSocketClient.ts";
import { selectWorkspaceForCwd } from "./workspaceSelection.ts";

function workspace(
  workspaceId: string,
  overrides: Partial<HerdrWireWorkspace> = {},
): HerdrWireWorkspace {
  return {
    workspace_id: workspaceId,
    number: 1,
    label: workspaceId,
    focused: false,
    pane_count: 0,
    tab_count: 0,
    active_tab_id: `${workspaceId}:t1`,
    agent_status: "idle",
    ...overrides,
  };
}

function pane(workspaceId: string, cwd: string): HerdrWirePane {
  return {
    pane_id: `${workspaceId}:p1`,
    terminal_id: `term-${workspaceId}`,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    focused: false,
    cwd,
    foreground_cwd: cwd,
    agent_status: "idle",
    revision: 1,
  };
}

function snapshot(
  workspaces: ReadonlyArray<HerdrWireWorkspace>,
  panes: ReadonlyArray<HerdrWirePane> = [],
): HerdrWireSnapshot {
  return {
    version: "0.7.4",
    protocol: 16,
    workspaces,
    tabs: [],
    panes,
    agents: [],
  };
}

describe("selectWorkspaceForCwd", () => {
  it("prefers an exact worktree checkout over pane and repository-root matches", () => {
    const checkout = workspace("checkout", {
      worktree: {
        repo_key: "/repo/.git",
        repo_name: "repo",
        repo_root: "/repo",
        checkout_path: "/repo/feature",
        is_linked_worktree: true,
      },
    });
    const paneWorkspace = workspace("pane");
    const repoRoot = workspace("root", {
      worktree: {
        repo_key: "/repo/feature/.git",
        repo_name: "feature",
        repo_root: "/repo/feature",
        checkout_path: "/elsewhere",
        is_linked_worktree: false,
      },
    });

    expect(
      selectWorkspaceForCwd(
        snapshot([repoRoot, paneWorkspace, checkout], [pane("pane", "/repo/feature")]),
        "/repo/feature/",
      )?.workspace_id,
    ).toBe("checkout");
  });

  it("uses an exact pane cwd when a workspace has no worktree metadata", () => {
    const target = workspace("target");

    expect(
      selectWorkspaceForCwd(snapshot([target], [pane("target", "/repo")]), "/repo")?.workspace_id,
    ).toBe("target");
  });

  it("falls back to an exact repository root", () => {
    const target = workspace("target", {
      worktree: {
        repo_key: "/repo/.git",
        repo_name: "repo",
        repo_root: "/repo",
        checkout_path: "/worktree",
        is_linked_worktree: false,
      },
    });

    expect(selectWorkspaceForCwd(snapshot([target]), "/repo")?.workspace_id).toBe("target");
  });

  it("does not fall back to the focused workspace when no path matches", () => {
    const focused = workspace("focused", { focused: true });

    expect(selectWorkspaceForCwd(snapshot([focused]), "/missing")).toBeNull();
  });
});
