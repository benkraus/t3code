import type { HerdrAgentStatus } from "./HerdrSocketClient.ts";

export function isAgentInputReady(
  agentName: string,
  status: HerdrAgentStatus,
  output: string,
): boolean {
  const normalizedName = agentName.trim().toLowerCase();
  if (normalizedName === "codex") return output.includes("OpenAI Codex");
  if (normalizedName === "claude" || normalizedName === "claude-code") {
    return output.includes("Claude Code");
  }
  return (status === "idle" || status === "done") && output.trim().length > 0;
}
