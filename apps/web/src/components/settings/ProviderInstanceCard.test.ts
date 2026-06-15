import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";
import { setCredentialEnvironmentVariable } from "./ProviderCredentialEnvironmentFields";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("setCredentialEnvironmentVariable", () => {
  const credential = {
    name: "ZHIPU_API_KEY",
    label: "Z.AI API key",
  };

  it("keeps an existing redacted secret when the credential field is left blank", () => {
    const environment = [
      {
        name: "ZHIPU_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
      {
        name: "OTHER_VAR",
        value: "visible",
        sensitive: false,
      },
    ];

    expect(setCredentialEnvironmentVariable(environment, credential, "")).toBe(environment);
  });

  it("stores credential edits as sensitive environment variables", () => {
    expect(setCredentialEnvironmentVariable([], credential, "  secret-key  ")).toEqual([
      {
        name: "ZHIPU_API_KEY",
        value: "secret-key",
        sensitive: true,
        valueRedacted: false,
      },
    ]);
  });
});
