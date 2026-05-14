import type { DesktopDiscoveredHost, ServerDiscoveryInfo } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEFAULT_T3CODE_PORT = 3773;
const TAILSCALE_STATUS_TIMEOUT_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 1_500;
const DISCOVERY_ROUTE_PATH = "/api/server-discovery";

export class TailscaleDiscoveryError extends Data.TaggedError("TailscaleDiscoveryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface TailscaleStatusCommandResult {
  stdout: string;
  stderr: string;
}

type FetchLike = typeof fetch;

interface TailscalePeerCandidate {
  id: string;
  name: string;
  host: string;
  dnsName: string | null;
  tailnetIp: string | null;
  os: string | null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeDnsName(value: unknown): string | null {
  const dnsName = asTrimmedString(value);
  return dnsName ? dnsName.replace(/\.$/, "") : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveScanPort(port: number | undefined): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return DEFAULT_T3CODE_PORT;
  }
  return port;
}

function buildRemoteUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
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

const tailscaleStatusCommandError = (
  cause: unknown,
  fallbackMessage = "Failed to query Tailscale status.",
): TailscaleDiscoveryError =>
  new TailscaleDiscoveryError({
    message: isMissingTailscaleCli(cause)
      ? "Tailscale CLI not found on PATH."
      : cause instanceof Error && cause.message.trim().length > 0
        ? cause.message
        : fallbackMessage,
    cause,
  });

const runTailscaleStatusCommand: Effect.Effect<
  TailscaleStatusCommandResult,
  TailscaleDiscoveryError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const args = ["status", "--json"];
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("tailscale", args, {
        shell: platform === "win32",
      }),
    )
    .pipe(Effect.mapError((cause) => tailscaleStatusCommandError(cause)));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectText(child.stdout), collectText(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError((cause) => tailscaleStatusCommandError(cause)));

  if (exitCode !== 0) {
    const message = stderr.trim();
    return yield* new TailscaleDiscoveryError({
      message: message.length > 0 ? message : `Tailscale status exited with code ${exitCode}.`,
    });
  }

  return { stdout, stderr };
}).pipe(
  Effect.scoped,
  Effect.timeoutOption(TAILSCALE_STATUS_TIMEOUT_MS),
  Effect.flatMap((result) =>
    Option.match(result, {
      onNone: () =>
        Effect.fail(new TailscaleDiscoveryError({ message: "Tailscale status timed out." })),
      onSome: Effect.succeed,
    }),
  ),
);

export function parseTailscaleStatusOutput(stdout: string): TailscalePeerCandidate[] {
  const parsed = JSON.parse(stdout) as {
    Self?: Record<string, unknown>;
    Peer?: Record<string, Record<string, unknown>>;
  };
  const selfDnsName = normalizeDnsName(parsed.Self?.DNSName);
  const peers = Object.values(parsed.Peer ?? {});

  return peers
    .flatMap((peer) => {
      if (asBoolean(peer.Online) !== true) {
        return [];
      }

      const dnsName = normalizeDnsName(peer.DNSName);
      const tailnetIp = asStringArray(peer.TailscaleIPs)[0] ?? null;
      const host = dnsName ?? tailnetIp;

      if (!host || host === selfDnsName) {
        return [];
      }

      return [
        {
          id: asTrimmedString(peer.ID) ?? host,
          name: asTrimmedString(peer.HostName) ?? dnsName ?? tailnetIp ?? host,
          host,
          dnsName,
          tailnetIp,
          os: asTrimmedString(peer.OS),
        } satisfies TailscalePeerCandidate,
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function isServerDiscoveryInfo(value: unknown): value is ServerDiscoveryInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.app === "t3code" && typeof candidate.authEnabled === "boolean";
}

async function fetchJsonWithTimeout(input: string, fetchImpl: FetchLike): Promise<Response> {
  return await fetchImpl(input, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
}

async function probeT3CodeHost(
  peer: TailscalePeerCandidate,
  port: number,
  fetchImpl: FetchLike,
): Promise<DesktopDiscoveredHost | null> {
  const remoteUrl = buildRemoteUrl(peer.host, port);

  try {
    const response = await fetchJsonWithTimeout(`${remoteUrl}${DISCOVERY_ROUTE_PATH}`, fetchImpl);
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as unknown;
    if (!isServerDiscoveryInfo(payload)) {
      return null;
    }

    return {
      id: peer.id,
      name: peer.name,
      host: peer.host,
      dnsName: peer.dnsName,
      tailnetIp: peer.tailnetIp,
      os: peer.os,
      remoteUrl,
      authEnabled: payload.authEnabled,
      tailnetAuthAvailable: payload.tailnetAuthAvailable === true,
    };
  } catch {
    return null;
  }
}

export function scanTailscaleHosts(options?: {
  port?: number;
  fetchImpl?: FetchLike;
}): Effect.Effect<
  DesktopDiscoveredHost[],
  TailscaleDiscoveryError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const port = resolveScanPort(options?.port);
    const fetchImpl = options?.fetchImpl ?? fetch;

    const { stdout } = yield* runTailscaleStatusCommand;
    const peers = yield* Effect.try({
      try: () => parseTailscaleStatusOutput(stdout),
      catch: (cause) =>
        new TailscaleDiscoveryError({
          message:
            cause instanceof Error && cause.message.trim().length > 0
              ? cause.message
              : "Failed to parse Tailscale status.",
          cause,
        }),
    });

    const discoveredHosts = yield* Effect.promise(() =>
      Promise.all(peers.map((peer) => probeT3CodeHost(peer, port, fetchImpl))),
    );

    return discoveredHosts.filter((host): host is DesktopDiscoveredHost => host !== null);
  });
}
