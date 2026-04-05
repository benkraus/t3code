import { describe, expect, it } from "vitest";

import { parseThreadPaneRouteSearch } from "./threadPaneRouteSearch";

describe("parseThreadPaneRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseThreadPaneRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean pane toggles as open", () => {
    expect(
      parseThreadPaneRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
        browser: true,
        simulator: true,
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      browser: "1",
      simulator: "1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseThreadPaneRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseThreadPaneRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseThreadPaneRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });
});
