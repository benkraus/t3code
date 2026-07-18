import { describe, expect, it } from "vite-plus/test";

import { isAgentInputReady } from "./readiness.ts";

describe("isAgentInputReady", () => {
  it("waits for the Codex UI banner instead of process detection alone", () => {
    expect(isAgentInputReady("codex", "idle", "$ codex\nBooting MCP server")).toBe(false);
    expect(isAgentInputReady("codex", "unknown", ">_ OpenAI Codex (v0.144.5)")).toBe(true);
  });

  it("recognizes Claude Code and has a conservative fallback for custom agents", () => {
    expect(isAgentInputReady("claude", "idle", "Welcome to Claude Code")).toBe(true);
    expect(isAgentInputReady("custom", "working", "ready")).toBe(false);
    expect(isAgentInputReady("custom", "done", "ready")).toBe(true);
  });
});
