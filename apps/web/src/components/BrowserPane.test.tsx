import { describe, expect, it } from "vitest";

import { normalizeBrowserUrl } from "./BrowserPane";

describe("normalizeBrowserUrl", () => {
  it("defaults empty values to the starter page", () => {
    expect(normalizeBrowserUrl("")).toBe("https://example.com");
  });

  it("preserves explicit schemes", () => {
    expect(normalizeBrowserUrl("https://openai.com")).toBe("https://openai.com");
    expect(normalizeBrowserUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("assumes http for local hosts and https elsewhere", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBrowserUrl("127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
  });
});
