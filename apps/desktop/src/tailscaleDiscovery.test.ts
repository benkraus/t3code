import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { parseTailscaleStatusOutput, scanTailscaleHosts } from "./tailscaleDiscovery";

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
  it("returns only peers that answer the discovery endpoint", async () => {
    const execFileImpl = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: ExecFileOptionsWithStringEncoding,
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => void
    >((_file, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
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
        "",
      );
    });

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "http://build-box.tail123.ts.net:4123/api/server-discovery") {
        return new Response(
          JSON.stringify({
            app: "t3code",
            authEnabled: true,
          }),
          { status: 200 },
        );
      }

      return new Response("Not Found", { status: 404 });
    });

    await expect(
      scanTailscaleHosts({
        port: 4123,
        execFileImpl,
        fetchImpl,
      }),
    ).resolves.toEqual([
      {
        id: "peer-a",
        name: "build-box",
        host: "build-box.tail123.ts.net",
        dnsName: "build-box.tail123.ts.net",
        tailnetIp: "100.64.0.12",
        os: "linux",
        remoteUrl: "http://build-box.tail123.ts.net:4123",
        authEnabled: true,
      },
    ]);
  });

  it("surfaces a clear error when tailscale is unavailable", async () => {
    const error = Object.assign(new Error("spawn tailscale ENOENT"), {
      code: "ENOENT",
    }) as ExecFileException;
    const execFileImpl = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: ExecFileOptionsWithStringEncoding,
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => void
    >((_file, _args, _options, callback) => {
      callback(error, "", "");
    });

    await expect(
      scanTailscaleHosts({
        execFileImpl,
        fetchImpl: vi.fn<typeof fetch>(),
      }),
    ).rejects.toThrow("Tailscale CLI not found on PATH.");
  });
});
