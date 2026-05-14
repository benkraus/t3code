import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { verifyTailnetPeer } from "./tailnet.ts";

const encoder = new TextEncoder();
const macOsTailscaleAppBinary = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const peerStatusJson =
  '{"Peer":{"a":{"ID":"peer-a","HostName":"build-box","DNSName":"build-box.tail123.ts.net.","TailscaleIPs":["100.64.0.12"],"OS":"linux"}}}';
const differentPeerStatusJson =
  '{"Peer":{"a":{"ID":"peer-a","HostName":"build-box","TailscaleIPs":["100.64.0.12"]}}}';
const selfAndPeerStatusJson =
  '{"Self":{"ID":"self-node","HostName":"local-box","TailscaleIPs":["100.64.0.10"],"OS":"macOS"},"Peer":{"a":{"ID":"peer-a","HostName":"build-box","TailscaleIPs":["100.64.0.12"]}}}';

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

it.effect("verifies a remote address against Tailscale peers", () =>
  Effect.gen(function* () {
    const peer = yield* verifyTailnetPeer({
      remoteAddress: "::ffff:100.64.0.12",
    }).pipe(Effect.provide(mockSpawnerLayer(() => ({ stdout: peerStatusJson }))));

    expect(peer).toEqual({
      subject: "tailnet:peer-a",
      label: "build-box (Tailnet)",
      ipAddress: "100.64.0.12",
      os: "linux",
    });
  }),
);

it.effect("rejects remote addresses outside the local tailnet", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      verifyTailnetPeer({
        remoteAddress: "100.64.0.99",
      }).pipe(Effect.provide(mockSpawnerLayer(() => ({ stdout: differentPeerStatusJson })))),
    );

    expect(result._tag).toBe("Failure");
  }),
);

it.effect("accepts the local machine when reached through its own tailnet address", () =>
  Effect.gen(function* () {
    const peer = yield* verifyTailnetPeer({
      remoteAddress: "100.64.0.10",
    }).pipe(Effect.provide(mockSpawnerLayer(() => ({ stdout: selfAndPeerStatusJson }))));

    expect(peer).toEqual({
      subject: "tailnet:self-node",
      label: "local-box (Tailnet)",
      ipAddress: "100.64.0.10",
      os: "macOS",
    });
  }),
);

it.effect("accepts the macOS app Tailscale binary candidate", () =>
  Effect.gen(function* () {
    const peer = yield* verifyTailnetPeer({
      remoteAddress: "100.64.0.12",
    }).pipe(
      Effect.provide(
        mockSpawnerLayer((command, args) => {
          expect(command).toBe(macOsTailscaleAppBinary);
          expect(args).toEqual(["status", "--json"]);
          return { stdout: differentPeerStatusJson };
        }),
      ),
    );

    expect(peer.subject).toBe("tailnet:peer-a");
  }),
);

it.effect("falls back to a shell launch when the macOS app binary returns non-JSON", () =>
  Effect.gen(function* () {
    const peer = yield* verifyTailnetPeer({
      remoteAddress: "100.64.0.12",
    }).pipe(
      Effect.provide(
        mockSpawnerLayer((command) =>
          command === macOsTailscaleAppBinary
            ? { stdout: "The Tailscale GUI is already running." }
            : { stdout: differentPeerStatusJson },
        ),
      ),
    );

    expect(peer.subject).toBe("tailnet:peer-a");
  }),
);

it.effect("maps a missing Tailscale CLI to a forbidden verification failure", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      verifyTailnetPeer({
        remoteAddress: "100.64.0.12",
      }).pipe(
        Effect.provide(
          mockSpawnerLayer(() => ({
            code: 127,
            stderr: "spawn tailscale ENOENT",
          })),
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
  }),
);
