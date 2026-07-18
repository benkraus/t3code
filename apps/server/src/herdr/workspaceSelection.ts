// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { HerdrWireSnapshot, HerdrWireWorkspace } from "./HerdrSocketClient.ts";

function normalizedPath(value: string): string {
  return NodePath.resolve(value);
}

function pathMatches(candidate: string | null | undefined, cwd: string): boolean {
  return candidate !== null && candidate !== undefined && normalizedPath(candidate) === cwd;
}

export function selectWorkspaceForCwd(
  snapshot: HerdrWireSnapshot,
  cwd: string,
): HerdrWireWorkspace | null {
  const normalizedCwd = normalizedPath(cwd);

  const checkoutMatch = snapshot.workspaces.find((workspace) =>
    pathMatches(workspace.worktree?.checkout_path, normalizedCwd),
  );
  if (checkoutMatch) return checkoutMatch;

  const paneMatch = snapshot.panes.find(
    (pane) =>
      pathMatches(pane.foreground_cwd, normalizedCwd) || pathMatches(pane.cwd, normalizedCwd),
  );
  if (paneMatch) {
    return (
      snapshot.workspaces.find((workspace) => workspace.workspace_id === paneMatch.workspace_id) ??
      null
    );
  }

  return (
    snapshot.workspaces.find((workspace) =>
      pathMatches(workspace.worktree?.repo_root, normalizedCwd),
    ) ?? null
  );
}
