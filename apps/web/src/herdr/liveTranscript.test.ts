import { describe, expect, it } from "vite-plus/test";

import { extractHerdrLiveAssistantMarkdown } from "./liveTranscript";

describe("extractHerdrLiveAssistantMarkdown", () => {
  it("extracts assistant narration after the latest submitted prompt", () => {
    const transcript = `
• Old response.

─ Worked for 8m ─────────────────────────

› fix it - fork herdr or t3code or whatever you need, get it done

• I’ll fix this in T3 Code. HerdR already supplies live pane-output updates; the missing
  layer is converting the active transcript into a streaming assistant message.

• Updated Plan
  └ Implement live rich assistant rendering.

• Ran rtk rg -n "agent.read" apps/server
  └ apps/server/src/herdr/HerdrSocketClient.ts:1

• Calling
  └ expect.playwright({"description":"Inspect the live timeline"})

• The parser now keeps narration and excludes tool blocks.

• Working (53s • esc to interrupt)

› Explain this codebase
`;

    expect(
      extractHerdrLiveAssistantMarkdown(
        transcript,
        "fix it - fork herdr or t3code or whatever you need, get it done",
      ),
    ).toBe(
      "I’ll fix this in T3 Code. HerdR already supplies live pane-output updates; the missing\n" +
        "layer is converting the active transcript into a streaming assistant message.\n\n" +
        "The parser now keeps narration and excludes tool blocks.",
    );
  });

  it("supports wrapped submitted prompts", () => {
    const transcript = `
› map the live HerdR session into the normal T3 timeline and preserve
  the finalized response

• The live bridge is active.
`;

    expect(
      extractHerdrLiveAssistantMarkdown(
        transcript,
        "map the live HerdR session into the normal T3 timeline and preserve the finalized response",
      ),
    ).toBe("The live bridge is active.");
  });

  it("returns null when the active prompt is not in the transcript", () => {
    expect(extractHerdrLiveAssistantMarkdown("• Unrelated output", "new prompt")).toBeNull();
  });
});
