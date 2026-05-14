import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "@effect/vitest";

import { parseTailscaleStatusOutput, scanTailscaleHosts } from "./tailscaleDiscovery.js";

const encoder = new TextEncoder();

function mockProcess(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { readonly stdout?: string; readonly stderr?: string; readonly code?: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockProcess(handler(childProcess.command, childProcess.args)));
    }),
  );
}

describe("parseTailscaleStatusOutput", () => {
  it("keeps online peers and prefers MagicDNS names", () => {
    const peers = parseTailscaleStatusOutput(
      JSON.stringify({
        Self: {
          DNSName: "laptop.tail123.ts.net.",
        },
        Peer: {
          a: {
            ID: "peer-a",
            HostName: "build-box",
            DNSName: "build-box.tail123.ts.net.",
            TailscaleIPs: ["100.64.0.12"],
            Online: true,
            OS: "linux",
          },
          b: {
            ID: "peer-b",
            HostName: "offline-box",
            DNSName: "offline-box.tail123.ts.net.",
            TailscaleIPs: ["100.64.0.13"],
            Online: false,
            OS: "linux",
          },
        },
      }),
    );

    expect(peers).toEqual([
      {
        id: "peer-a",
        name: "build-box",
        host: "build-box.tail123.ts.net",
        dnsName: "build-box.tail123.ts.net",
        tailnetIp: "100.64.0.12",
        os: "linux",
      },
    ]);
  });
});

describe("scanTailscaleHosts", () => {
  it.effect("returns only peers that answer the discovery endpoint", () => {
    const spawnerLayer = mockSpawnerLayer((command, args) => {
      expect(command).toBe("tailscale");
      expect(args).toEqual(["status", "--json"]);
      return {
        stdout: JSON.stringify({
          Peer: {
            a: {
              ID: "peer-a",
              HostName: "build-box",
              DNSName: "build-box.tail123.ts.net.",
              TailscaleIPs: ["100.64.0.12"],
              Online: true,
              OS: "linux",
            },
            b: {
              ID: "peer-b",
              HostName: "db-box",
              DNSName: "db-box.tail123.ts.net.",
              TailscaleIPs: ["100.64.0.13"],
              Online: true,
              OS: "linux",
            },
          },
        }),
      };
    });

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://build-box.tail123.ts.net:4123/api/server-discovery") {
        return new Response(
          JSON.stringify({
            app: "t3code",
            authEnabled: true,
            tailnetAuthAvailable: true,
          }),
          { status: 200 },
        );
      }

      return new Response("Not Found", { status: 404 });
    });

    return Effect.gen(function* () {
      const hosts = yield* scanTailscaleHosts({
        port: 4123,
        fetchImpl,
      }).pipe(Effect.provide(spawnerLayer));
      expect(hosts).toEqual([
        {
          id: "peer-a",
          name: "build-box",
          host: "build-box.tail123.ts.net",
          dnsName: "build-box.tail123.ts.net",
          tailnetIp: "100.64.0.12",
          os: "linux",
          remoteUrl: "http://build-box.tail123.ts.net:4123",
          authEnabled: true,
          tailnetAuthAvailable: true,
        },
      ]);
    });
  });

  it.effect("surfaces a clear error when tailscale is unavailable", () => {
    const spawnerLayer = mockSpawnerLayer(() => ({
      code: 127,
      stderr: "Tailscale CLI not found on PATH.",
    }));

    return Effect.gen(function* () {
      const error = yield* scanTailscaleHosts({
        fetchImpl: vi.fn<typeof fetch>(),
      }).pipe(Effect.provide(spawnerLayer), Effect.flip);
      expect(error.message).toBe("Tailscale CLI not found on PATH.");
    });
  });
});
