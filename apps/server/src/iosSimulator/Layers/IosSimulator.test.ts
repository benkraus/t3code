import type { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  captureBootedIphoneSimulatorFrame,
  inspectIosSimulatorEnvironment,
  selectBootedIphoneSimulator,
} from "./IosSimulator";

describe("selectBootedIphoneSimulator", () => {
  it("picks the most recently booted iphone", () => {
    expect(
      selectBootedIphoneSimulator(
        JSON.stringify({
          devices: {
            runtime: [
              {
                name: "iPhone 15",
                udid: "older",
                state: "Booted",
                lastBootedAt: "2026-04-04T09:00:00Z",
              },
              {
                name: "iPhone 16 Pro",
                udid: "newer",
                state: "Booted",
                lastBootedAt: "2026-04-05T09:00:00Z",
              },
              {
                name: "iPad Pro (11-inch)",
                udid: "ipad",
                state: "Booted",
              },
            ],
          },
        }),
      ),
    ).toEqual({
      name: "iPhone 16 Pro",
      udid: "newer",
      lastBootedAt: "2026-04-05T09:00:00Z",
    });
  });
});

describe("inspectIosSimulatorEnvironment", () => {
  it("reports unsupported platforms", () => {
    expect(inspectIosSimulatorEnvironment({ platform: "linux" }).status).toEqual({
      reason: "unsupported-platform",
      supported: false,
      available: false,
      message: "iPhone simulator streaming is only available when the server is running on macOS.",
      interactionSupported: false,
      interactionAvailable: false,
    });
  });

  it("reports missing booted iphones", () => {
    const spawn = vi.fn(() => ({
      pid: 1,
      output: [null, JSON.stringify({ devices: { runtime: [] } }), ""],
      stdout: JSON.stringify({ devices: { runtime: [] } }),
      stderr: "",
      status: 0,
      signal: null,
      error: undefined,
    }));

    expect(
      inspectIosSimulatorEnvironment({
        platform: "darwin",
        spawn: spawn as unknown as typeof spawnSync,
      }).status,
    ).toEqual({
      reason: "no-booted-iphone",
      supported: true,
      available: false,
      message: "Boot an iPhone simulator on the host Mac to mirror it here.",
      interactionSupported: true,
      interactionAvailable: false,
    });
  });
});

describe("captureBootedIphoneSimulatorFrame", () => {
  it("captures a png frame for the selected iphone", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({
        pid: 1,
        output: [
          null,
          JSON.stringify({
            devices: {
              runtime: [{ name: "iPhone 16 Pro", udid: "sim-123", state: "Booted" }],
            },
          }),
          "",
        ],
        stdout: JSON.stringify({
          devices: {
            runtime: [{ name: "iPhone 16 Pro", udid: "sim-123", state: "Booted" }],
          },
        }),
        stderr: "",
        status: 0,
        signal: null,
        error: undefined,
      })
      .mockReturnValueOnce({
        pid: 2,
        output: [null, Buffer.from([137, 80, 78, 71]), Buffer.alloc(0)],
        stdout: Buffer.from([137, 80, 78, 71]),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
        error: undefined,
      });

    expect(
      captureBootedIphoneSimulatorFrame({
        platform: "darwin",
        spawn: spawn as unknown as typeof spawnSync,
      }),
    ).toEqual({
      contentType: "image/png",
      data: Uint8Array.from([137, 80, 78, 71]),
    });
  });
});
