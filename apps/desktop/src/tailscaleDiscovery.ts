import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

import type { DesktopDiscoveredHost, ServerDiscoveryInfo } from "@t3tools/contracts";

const DEFAULT_T3CODE_PORT = 3773;
const TAILSCALE_STATUS_TIMEOUT_MS = 5_000;
const DISCOVERY_TIMEOUT_MS = 1_500;
const DISCOVERY_ROUTE_PATH = "/api/server-discovery";

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

type ExecFileLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

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

function runExecFile(
  file: string,
  args: ReadonlyArray<string>,
  execFileImpl: ExecFileLike,
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      file,
      args,
      {
        encoding: "utf8",
        timeout: TAILSCALE_STATUS_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      } satisfies ExecFileOptionsWithStringEncoding,
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === "ENOENT") {
            reject(new Error("Tailscale CLI not found on PATH."));
            return;
          }

          const message = stderr.trim() || error.message;
          reject(new Error(message.length > 0 ? message : "Failed to query Tailscale status."));
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

function defaultExecFileImpl(
  file: string,
  args: ReadonlyArray<string>,
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): void {
  execFile(file, [...args], options, callback);
}

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    return await fetchImpl(input, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
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
    };
  } catch {
    return null;
  }
}

export async function scanTailscaleHosts(options?: {
  port?: number;
  execFileImpl?: ExecFileLike;
  fetchImpl?: FetchLike;
}): Promise<DesktopDiscoveredHost[]> {
  const port = resolveScanPort(options?.port);
  const execFileImpl = options?.execFileImpl ?? defaultExecFileImpl;
  const fetchImpl = options?.fetchImpl ?? fetch;

  const { stdout } = await runExecFile("tailscale", ["status", "--json"], execFileImpl);
  const peers = parseTailscaleStatusOutput(stdout);

  const discoveredHosts = await Promise.all(
    peers.map((peer) => probeT3CodeHost(peer, port, fetchImpl)),
  );

  return discoveredHosts.filter((host): host is DesktopDiscoveredHost => host !== null);
}
