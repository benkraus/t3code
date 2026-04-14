import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import type { IosSimulatorInteractionInput, IosSimulatorStatus } from "@t3tools/contracts";
import { Data, Effect, FileSystem, Layer, Path, Stream } from "effect";

import { runProcess } from "../../processRunner";
import {
  IosSimulator,
  type IosSimulatorFrame,
  type IosSimulatorMultipartStream,
  type IosSimulatorShape,
} from "../Services/IosSimulator";
import { getIosSimulatorInteractionStatus, sendIosSimulatorInteraction } from "./interactionHelper";
import { getIosSimulatorMjpegStream, IOS_SIMULATOR_MJPEG_CONTENT_TYPE } from "./streamHelper";

interface BootedIphoneDevice {
  readonly name: string;
  readonly udid: string;
  readonly lastBootedAt: string | null;
}

interface SimctlInspection {
  readonly status: IosSimulatorStatus;
  readonly device: BootedIphoneDevice | null;
}

type SpawnLike = typeof spawnSync;

class IosSimulatorCommandError extends Data.TaggedError("IosSimulatorCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function utf8Output(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (value instanceof Buffer) {
    return value.toString("utf8").trim();
  }

  return "";
}

function bufferOutput(value: string | Buffer | null | undefined): Uint8Array {
  if (value instanceof Buffer) {
    return new Uint8Array(value);
  }

  if (typeof value === "string") {
    return new Uint8Array(Buffer.from(value, "binary"));
  }

  return new Uint8Array();
}

function describeCommandFailure(
  command: string,
  args: ReadonlyArray<string>,
  result: SpawnSyncReturns<Buffer | string>,
): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return `Command not found: ${command}`;
    }
    return `Failed to run ${[command, ...args].join(" ")}: ${result.error.message}`;
  }

  const stderr = utf8Output(result.stderr);
  if (stderr.length > 0) {
    return stderr;
  }

  return `Command failed: ${[command, ...args].join(" ")}`;
}

function statusWithInteraction(
  status: Omit<
    IosSimulatorStatus,
    "interactionSupported" | "interactionAvailable" | "interactionMessage"
  >,
  interaction?: {
    readonly supported: boolean;
    readonly available: boolean;
    readonly message?: string;
  },
): IosSimulatorStatus {
  return {
    ...status,
    interactionSupported:
      interaction?.supported ??
      (status.reason !== "unsupported-platform" && status.reason !== "simctl-unavailable"),
    interactionAvailable: interaction?.available ?? false,
    ...(interaction?.message ? { interactionMessage: interaction.message } : {}),
  };
}

export function selectBootedIphoneSimulator(rawJson: string): BootedIphoneDevice | null {
  const parsed = JSON.parse(rawJson) as { devices?: Record<string, unknown> };
  const runtimes = parsed.devices;
  if (!runtimes || typeof runtimes !== "object") {
    return null;
  }

  const candidates: BootedIphoneDevice[] = [];
  for (const runtimeDevices of Object.values(runtimes)) {
    if (!Array.isArray(runtimeDevices)) {
      continue;
    }

    for (const rawDevice of runtimeDevices) {
      if (!rawDevice || typeof rawDevice !== "object") {
        continue;
      }

      const device = rawDevice as {
        name?: unknown;
        state?: unknown;
        udid?: unknown;
        lastBootedAt?: unknown;
      };
      const name = typeof device.name === "string" ? device.name.trim() : "";
      const state = typeof device.state === "string" ? device.state.trim() : "";
      const udid = typeof device.udid === "string" ? device.udid.trim() : "";
      const lastBootedAt =
        typeof device.lastBootedAt === "string" ? device.lastBootedAt.trim() || null : null;

      if (state !== "Booted" || !name.toLowerCase().includes("iphone") || udid.length === 0) {
        continue;
      }

      candidates.push({ name, udid, lastBootedAt });
    }
  }

  candidates.sort((left, right) =>
    (right.lastBootedAt ?? "").localeCompare(left.lastBootedAt ?? ""),
  );
  return candidates[0] ?? null;
}

export function inspectIosSimulatorEnvironment(input?: {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnLike;
}): SimctlInspection {
  const platform = input?.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      device: null,
      status: statusWithInteraction({
        reason: "unsupported-platform",
        supported: false,
        available: false,
        message:
          "iPhone simulator streaming is only available when the server is running on macOS.",
      }),
    };
  }

  const spawn = input?.spawn ?? spawnSync;
  const listArgs = ["simctl", "list", "devices", "--json"] as const;
  const listResult = spawn("xcrun", [...listArgs], {
    encoding: "utf8",
    timeout: 5_000,
  });

  if (listResult.error) {
    return {
      device: null,
      status: statusWithInteraction({
        reason: "simctl-unavailable",
        supported: false,
        available: false,
        message:
          "Xcode simulator tools are unavailable on the host Mac. Install Xcode and the iOS Simulator runtime.",
      }),
    };
  }

  if (listResult.status !== 0) {
    return {
      device: null,
      status: statusWithInteraction({
        reason: "unreachable",
        supported: true,
        available: false,
        message: describeCommandFailure("xcrun", listArgs, listResult),
      }),
    };
  }

  try {
    const device = selectBootedIphoneSimulator(String(listResult.stdout));
    if (!device) {
      return {
        device: null,
        status: statusWithInteraction({
          reason: "no-booted-iphone",
          supported: true,
          available: false,
          message: "Boot an iPhone simulator on the host Mac to mirror it here.",
        }),
      };
    }

    return {
      device,
      status: statusWithInteraction({
        reason: "available",
        supported: true,
        available: true,
        message: `Streaming ${device.name} from the host Mac.`,
        deviceName: device.name,
        udid: device.udid,
      }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unable to parse simctl device list.";
    return {
      device: null,
      status: statusWithInteraction({
        reason: "unreachable",
        supported: true,
        available: false,
        message: detail.trim() || "Unable to inspect iPhone simulators on the host Mac.",
      }),
    };
  }
}

export function captureBootedIphoneSimulatorFrame(input?: {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnLike;
}): IosSimulatorFrame {
  const inspection = inspectIosSimulatorEnvironment(input);
  if (!inspection.status.available || !inspection.device) {
    throw new Error(inspection.status.message);
  }

  const spawn = input?.spawn ?? spawnSync;
  const screenshotArgs = [
    "simctl",
    "io",
    inspection.device.udid,
    "screenshot",
    "--type=png",
    "-",
  ] as const;
  const screenshotResult = spawn("xcrun", [...screenshotArgs], {
    encoding: "buffer",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (screenshotResult.error || screenshotResult.status !== 0) {
    throw new Error(describeCommandFailure("xcrun", screenshotArgs, screenshotResult));
  }

  const data = bufferOutput(screenshotResult.stdout);
  if (data.byteLength === 0) {
    throw new Error("The simulator screenshot command returned an empty frame.");
  }

  return {
    contentType: "image/png",
    data,
  };
}

async function captureBootedIphoneSimulatorJpegFrame(input: {
  readonly udid: string;
  readonly filePath: string;
}): Promise<Uint8Array> {
  await runProcess(
    "xcrun",
    ["simctl", "io", input.udid, "screenshot", "--type=jpeg", input.filePath],
    {
      timeoutMs: 10_000,
    },
  );

  const data = new Uint8Array(await readFile(input.filePath));
  if (data.byteLength === 0) {
    throw new Error("The simulator screenshot command returned an empty JPEG frame.");
  }

  return data;
}

function encodeMultipartJpegFrame(frame: Uint8Array): Uint8Array {
  const header = Buffer.from(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.byteLength}\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from("\r\n", "utf8");
  return Buffer.concat([header, Buffer.from(frame), footer]);
}

export const makeIosSimulator = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const inspectStatus: IosSimulatorShape["getStatus"] = Effect.gen(function* () {
    const platform = process.platform;
    if (platform !== "darwin") {
      return inspectIosSimulatorEnvironment({ platform }).status;
    }

    const listDevices = yield* Effect.tryPromise({
      try: () =>
        runProcess("xcrun", ["simctl", "list", "devices", "--json"], {
          timeoutMs: 5_000,
        }),
      catch: (error) =>
        new IosSimulatorCommandError({
          message:
            error instanceof Error
              ? error.message
              : "Unable to inspect iPhone simulators on the host Mac.",
          cause: error,
        }),
    }).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );

    if (!listDevices.ok) {
      const message = listDevices.error.message;
      if (message.startsWith("Command not found:")) {
        return statusWithInteraction({
          reason: "simctl-unavailable",
          supported: false,
          available: false,
          message:
            "Xcode simulator tools are unavailable on the host Mac. Install Xcode and the iOS Simulator runtime.",
        }) satisfies IosSimulatorStatus;
      }

      return statusWithInteraction({
        reason: "unreachable",
        supported: true,
        available: false,
        message,
      }) satisfies IosSimulatorStatus;
    }

    const baseStatus = inspectIosSimulatorEnvironment({
      platform,
      spawn: ((..._args) => {
        return {
          output: [null, listDevices.result.stdout, listDevices.result.stderr],
          stdout: listDevices.result.stdout,
          stderr: listDevices.result.stderr,
          status: listDevices.result.code ?? 0,
          signal: listDevices.result.signal,
          error: undefined,
          pid: 0,
        } as unknown as SpawnSyncReturns<string>;
      }) as SpawnLike,
    }).status;

    if (!baseStatus.available || !baseStatus.deviceName) {
      return baseStatus;
    }

    const interaction = yield* getIosSimulatorInteractionStatus({
      fileSystem,
      path,
      deviceName: baseStatus.deviceName,
    });

    return statusWithInteraction(baseStatus, interaction);
  });

  const captureFrame: IosSimulatorShape["captureFrame"] = Effect.scoped(
    Effect.gen(function* () {
      const status = yield* inspectStatus;
      if (!status.available || !status.udid) {
        return yield* Effect.fail(new Error(status.message));
      }

      const udid = status.udid;
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-ios-simulator-",
      });
      const screenshotPath = path.join(tempDirectory, "frame.png");
      yield* Effect.tryPromise({
        try: () =>
          runProcess("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", screenshotPath], {
            timeoutMs: 10_000,
          }),
        catch: (error) =>
          new IosSimulatorCommandError({
            message:
              error instanceof Error
                ? error.message
                : "Unable to capture an iPhone simulator frame from the host Mac.",
            cause: error,
          }),
      }).pipe(Effect.mapError((error) => new Error(error.message)));

      const data = yield* fileSystem
        .readFile(screenshotPath)
        .pipe(
          Effect.mapError(
            (error) =>
              new Error(
                error instanceof Error
                  ? error.message
                  : "The simulator screenshot command did not produce a readable frame.",
              ),
          ),
        );
      if (data.byteLength === 0) {
        return yield* Effect.fail(
          new Error("The simulator screenshot command returned an empty frame."),
        );
      }

      return {
        contentType: "image/png",
        data,
      } satisfies IosSimulatorFrame;
    }),
  );

  const openMjpegStream: IosSimulatorShape["openMjpegStream"] = Effect.gen(function* () {
    const status = yield* inspectStatus;
    if (!status.available || !status.udid || !status.deviceName) {
      return yield* Effect.fail(new Error(status.message));
    }
    const udid = status.udid;

    const preferredStream = yield* getIosSimulatorMjpegStream({
      fileSystem,
      path,
      deviceName: status.deviceName,
    }).pipe(
      Effect.mapError((error) => new Error(error.message)),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (preferredStream) {
      return preferredStream;
    }
    const tempDirectory = yield* fileSystem.makeTempDirectory({
      prefix: "t3-ios-simulator-stream-",
    });
    const screenshotPath = path.join(tempDirectory, "frame.jpg");

    const fallbackStream = Stream.fromAsyncIterable(
      {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              const frame = await captureBootedIphoneSimulatorJpegFrame({
                udid,
                filePath: screenshotPath,
              });
              yield encodeMultipartJpegFrame(frame);
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          } catch (error) {
            throw error instanceof Error
              ? error
              : new Error("Unable to capture an iPhone simulator frame from the host Mac.");
          } finally {
            await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
        },
      },
      (cause) => new Error(String(cause)),
    );

    return {
      contentType: IOS_SIMULATOR_MJPEG_CONTENT_TYPE,
      stream: fallbackStream,
    } satisfies IosSimulatorMultipartStream;
  });

  const sendInput: IosSimulatorShape["sendInput"] = (input: IosSimulatorInteractionInput) =>
    Effect.gen(function* () {
      const status = yield* inspectStatus;
      if (!status.available || !status.deviceName) {
        return yield* Effect.fail(new Error(status.message));
      }

      yield* sendIosSimulatorInteraction({
        fileSystem,
        path,
        deviceName: status.deviceName,
        interaction: input,
      });
    });

  return {
    getStatus: inspectStatus,
    captureFrame,
    openMjpegStream,
    sendInput,
  } satisfies IosSimulatorShape;
});

export const IosSimulatorLive = Layer.effect(IosSimulator, makeIosSimulator);
