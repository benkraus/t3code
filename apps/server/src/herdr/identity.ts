import * as NodeCrypto from "node:crypto";

import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { HerdrWirePane, HerdrWireWorkspace } from "./HerdrSocketClient.ts";

function stableHash(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function herdrProjectId(
  instanceId: ProviderInstanceId,
  workspace: HerdrWireWorkspace,
): ProjectId {
  const identity =
    workspace.worktree?.repo_key ?? workspace.worktree?.repo_root ?? workspace.workspace_id;
  return ProjectId.make(`herdr-project-${stableHash(`${instanceId}:${identity}`)}`);
}

export function herdrThreadId(instanceId: ProviderInstanceId, pane: HerdrWirePane): ThreadId {
  return ThreadId.make(`herdr-thread-${stableHash(`${instanceId}:terminal:${pane.terminal_id}`)}`);
}

export function splitCommand(command: string): ReadonlyArray<string> {
  const trimmed = command.trim();
  if (trimmed.length === 0) return [];
  const matches = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((entry) => {
    const first = entry[0];
    const last = entry.at(-1);
    return (first === '"' && last === '"') || (first === "'" && last === "'")
      ? entry.slice(1, -1)
      : entry;
  });
}

export function herdrLaunchName(agentName: string, terminalId: string): string {
  const base = agentName.trim().replaceAll(/\s+/g, "-").slice(0, 40) || "agent";
  const suffix = terminalId.replaceAll(/[^a-zA-Z0-9_-]/g, "").slice(-16) || "pane";
  return `${base}-t3-${suffix}`;
}
