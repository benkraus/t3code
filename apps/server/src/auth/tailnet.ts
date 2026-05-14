import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const TAILSCALE_STATUS_TIMEOUT_MS = 2_000;
const MACOS_TAILSCALE_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const TAILSCALE_COMMAND_CANDIDATES = [
  {
    file: MACOS_TAILSCALE_APP_BINARY,
    args: ["status", "--json"],
    label: MACOS_TAILSCALE_APP_BINARY,
  },
  {
    file: "/bin/zsh",
    args: ["-lc", `exec ${MACOS_TAILSCALE_APP_BINARY} status --json`],
    label: `${MACOS_TAILSCALE_APP_BINARY} via shell`,
  },
  {
    file: "/Applications/Tailscale.app/Contents/Resources/tailscale",
    args: ["status", "--json"],
    label: "/Applications/Tailscale.app/Contents/Resources/tailscale",
  },
  { file: "tailscale", args: ["status", "--json"], label: "tailscale" },
  {
    file: "/opt/homebrew/bin/tailscale",
    args: ["status", "--json"],
    label: "/opt/homebrew/bin/tailscale",
  },
  {
    file: "/usr/local/bin/tailscale",
    args: ["status", "--json"],
    label: "/usr/local/bin/tailscale",
  },
  { file: "/usr/bin/tailscale", args: ["status", "--json"], label: "/usr/bin/tailscale" },
] as const;

interface TailscalePeerRecord {
  readonly id: string;
  readonly name: string;
  readonly dnsName: string | null;
  readonly os: string | null;
  readonly tailscaleIps: ReadonlyArray<string>;
}

export interface VerifiedTailnetPeer {
  readonly subject: string;
  readonly label: string;
  readonly ipAddress: string;
  readonly os?: string;
}

export class TailnetPeerVerificationError extends Data.TaggedError("TailnetPeerVerificationError")<{
  readonly message: string;
  readonly status?: 401 | 403 | 500;
  readonly cause?: unknown;
}> {}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDnsName(value: unknown): string | null {
  const dnsName = normalizeNonEmptyString(value);
  return dnsName ? dnsName.replace(/\.$/, "") : null;
}

function normalizeIpAddress(value: string): string {
  const trimmed = value.trim().replace(/^\[(.*)\]$/, "$1");
  const withoutIpv4Prefix = trimmed.startsWith("::ffff:")
    ? trimmed.slice("::ffff:".length)
    : trimmed;
  const zoneIndex = withoutIpv4Prefix.indexOf("%");
  return zoneIndex === -1 ? withoutIpv4Prefix : withoutIpv4Prefix.slice(0, zoneIndex);
}

function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeNonEmptyString(entry))
    .filter((entry): entry is string => entry !== null);
}

function parseTailscalePeerRecord(peer: Record<string, unknown>): TailscalePeerRecord | null {
  const tailscaleIps = asStringArray(peer.TailscaleIPs).map(normalizeIpAddress);
  if (tailscaleIps.length === 0) {
    return null;
  }

  const dnsName = normalizeDnsName(peer.DNSName);
  const name = normalizeNonEmptyString(peer.HostName) ?? dnsName ?? tailscaleIps[0]!;
  return {
    id: normalizeNonEmptyString(peer.ID) ?? tailscaleIps[0]!,
    name,
    dnsName,
    os: normalizeNonEmptyString(peer.OS),
    tailscaleIps,
  } satisfies TailscalePeerRecord;
}

function parseTailscalePeerRecords(stdout: string): ReadonlyArray<TailscalePeerRecord> {
  const parsed = JSON.parse(stdout) as {
    Self?: Record<string, unknown>;
    Peer?: Record<string, Record<string, unknown>>;
  };

  return [parsed.Self, ...Object.values(parsed.Peer ?? {})]
    .map((peer) => (peer ? parseTailscalePeerRecord(peer) : null))
    .filter((peer): peer is TailscalePeerRecord => peer !== null);
}

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function isMissingTailscaleCli(cause: unknown): boolean {
  return cause instanceof Error && /\bENOENT\b/u.test(cause.message);
}

function tailscaleStatusError(
  candidate: (typeof TAILSCALE_COMMAND_CANDIDATES)[number],
  cause: unknown,
): TailnetPeerVerificationError {
  const message =
    cause instanceof Error && cause.message.trim().length > 0
      ? cause.message
      : "Failed to query Tailscale status.";
  return new TailnetPeerVerificationError({
    message: `${candidate.label}: ${message}`,
    status: isMissingTailscaleCli(cause) ? 403 : 500,
    cause,
  });
}

function readTailscaleStatusCandidate(
  candidate: (typeof TAILSCALE_COMMAND_CANDIDATES)[number],
): Effect.Effect<string, TailnetPeerVerificationError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(candidate.file, candidate.args, {
          shell: platform === "win32",
        }),
      )
      .pipe(Effect.mapError((cause) => tailscaleStatusError(candidate, cause)));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectText(child.stdout),
        collectText(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError((cause) => tailscaleStatusError(candidate, cause)));

    if (exitCode !== 0) {
      const message = stderr.trim();
      return yield* new TailnetPeerVerificationError({
        message:
          message.length > 0
            ? `${candidate.label}: ${message}`
            : `${candidate.label}: Tailscale status exited with code ${exitCode}.`,
        status: exitCode === 127 ? 403 : 500,
      });
    }

    if (!stdout.trimStart().startsWith("{")) {
      return yield* new TailnetPeerVerificationError({
        message: `${candidate.label}: Tailscale status did not return JSON.`,
        status: 403,
        cause: stdout.slice(0, 200),
      });
    }

    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(TAILSCALE_STATUS_TIMEOUT_MS),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(
            new TailnetPeerVerificationError({
              message: `${candidate.label}: Tailscale status timed out.`,
              status: 500,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

function readTailscaleStatus(): Effect.Effect<
  string,
  TailnetPeerVerificationError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const errors: string[] = [];

    for (const candidate of TAILSCALE_COMMAND_CANDIDATES) {
      const result = yield* readTailscaleStatusCandidate(candidate).pipe(
        Effect.matchEffect({
          onFailure: (error) => Effect.succeed({ _tag: "failure" as const, error }),
          onSuccess: (stdout) => Effect.succeed({ _tag: "success" as const, stdout }),
        }),
      );

      if (result._tag === "success") {
        return result.stdout;
      }
      if (result.error.status !== 403) {
        return yield* result.error;
      }

      errors.push(result.error.message);
    }

    return yield* new TailnetPeerVerificationError({
      message:
        errors.length > 0
          ? `Failed to query Tailscale status. Attempts: ${errors.join("; ")}`
          : "Failed to query Tailscale status.",
      status: 403,
    });
  });
}

export function verifyTailnetPeer(input: {
  readonly remoteAddress: string | undefined;
}): Effect.Effect<
  VerifiedTailnetPeer,
  TailnetPeerVerificationError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if (!input.remoteAddress) {
      return yield* new TailnetPeerVerificationError({
        message: "Tailnet authentication requires a remote peer address.",
        status: 401,
      });
    }

    const remoteAddress = normalizeIpAddress(input.remoteAddress);
    const stdout = yield* readTailscaleStatus();
    const peers = parseTailscalePeerRecords(stdout);
    const peer = peers.find((candidate) => candidate.tailscaleIps.includes(remoteAddress));
    if (!peer) {
      return yield* new TailnetPeerVerificationError({
        message: "Remote peer is not a known Tailscale peer.",
        status: 403,
      });
    }

    return {
      subject: `tailnet:${peer.id}`,
      label: `${peer.name} (Tailnet)`,
      ipAddress: remoteAddress,
      ...(peer.os ? { os: peer.os } : {}),
    } satisfies VerifiedTailnetPeer;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof TailnetPeerVerificationError
        ? cause
        : new TailnetPeerVerificationError({
            message: "Failed to verify Tailscale peer.",
            status: 500,
            cause,
          }),
    ),
  );
}
