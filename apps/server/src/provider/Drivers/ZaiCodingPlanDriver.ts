/**
 * ZaiCodingPlanDriver — first-class Z.AI Coding Plan provider backed by OpenCode.
 *
 * OpenCode owns the upstream protocol and process management. This driver gives
 * T3 Code a separate provider identity, credential surface, and model allow-list
 * for the `zai-coding-plan/*` GLM models.
 *
 * @module provider/Drivers/ZaiCodingPlanDriver
 */
import {
  OpenCodeSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ZaiCodingPlanSettings,
  ZaiCodingPlanSettings as ZaiCodingPlanSettingsSchema,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
  type OpenCodeProviderPresentation,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";

const decodeZaiCodingPlanSettings = Schema.decodeSync(ZaiCodingPlanSettingsSchema);

const DRIVER_KIND = ProviderDriverKind.make("zaiCodingPlan");
const DISPLAY_NAME = "Z.AI Coding Plan";
const ZAI_CODING_PLAN_PROVIDER_IDS: ReadonlySet<string> = new Set(["zai-coding-plan"]);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const PRESENTATION = {
  displayName: DISPLAY_NAME,
  showInteractionModeToggle: false,
} satisfies OpenCodeProviderPresentation;
const OPENCODE_STATUS_OPTIONS = {
  driverKind: DRIVER_KIND,
  presentation: PRESENTATION,
  modelProviderIds: ZAI_CODING_PLAN_PROVIDER_IDS,
  missingConnectionMessage:
    "Set ZHIPU_API_KEY in this provider's environment to connect Z.AI Coding Plan through OpenCode.",
} as const;

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "opencode-ai",
  homebrewFormula: "anomalyco/tap/opencode",
  nativeUpdate: {
    executable: "opencode",
    args: ["upgrade"],
    lockKey: "opencode-native",
    isCommandPath: isOpenCodeNativeCommandPath,
  },
});

export type ZaiCodingPlanDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

function toOpenCodeSettings(settings: ZaiCodingPlanSettings): OpenCodeSettings {
  return {
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    serverUrl: "",
    serverPassword: "",
    customModels: settings.customModels,
  };
}

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ZaiCodingPlanDriver: ProviderDriver<ZaiCodingPlanSettings, ZaiCodingPlanDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: DISPLAY_NAME,
    supportsMultipleInstances: true,
  },
  configSchema: ZaiCodingPlanSettingsSchema,
  defaultConfig: (): ZaiCodingPlanSettings => decodeZaiCodingPlanSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies ZaiCodingPlanSettings;
      const openCodeSettings = toOpenCodeSettings(effectiveConfig);
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: openCodeSettings.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeOpenCodeAdapter(openCodeSettings, {
        providerKind: DRIVER_KIND,
        providerLabel: DISPLAY_NAME,
        instanceId,
        modelProviderIds: ZAI_CODING_PLAN_PROVIDER_IDS,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(openCodeSettings, processEnv, {
        providerLabel: DISPLAY_NAME,
        modelProviderIds: ZAI_CODING_PLAN_PROVIDER_IDS,
      });

      const checkProvider = checkOpenCodeProviderStatus(
        openCodeSettings,
        serverConfig.cwd,
        processEnv,
        OPENCODE_STATUS_OPTIONS,
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCodeRuntime, openCodeRuntime));

      const snapshot = yield* makeManagedServerProvider<ZaiCodingPlanSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () =>
          makePendingOpenCodeProvider(openCodeSettings, OPENCODE_STATUS_OPTIONS).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ${DISPLAY_NAME} snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
