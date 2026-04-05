import { describe, expect, it } from "vitest";

import { parseQuerySearch, stringifyQuerySearch } from "./searchSerialization";

describe("searchSerialization", () => {
  it("stringifies plain string values without json quotes", () => {
    expect(
      stringifyQuerySearch({
        simulator: "1",
        diff: "1",
        diffFilePath: "src/app.ts",
      }),
    ).toBe("?simulator=1&diff=1&diffFilePath=src%2Fapp.ts");
  });

  it("drops undefined values", () => {
    expect(
      stringifyQuerySearch({
        simulator: undefined,
        browser: "1",
      }),
    ).toBe("?browser=1");
  });

  it("parses search strings into plain decoded values", () => {
    expect(parseQuerySearch("?simulator=1&diffFilePath=src%2Fapp.ts")).toEqual({
      simulator: "1",
      diffFilePath: "src/app.ts",
    });
  });
});
