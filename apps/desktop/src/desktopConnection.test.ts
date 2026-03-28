import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DESKTOP_CONNECTION_SETTINGS,
  isRemoteDesktopConnection,
  normalizeDesktopRemoteUrl,
  parseDesktopConnectionSettingsInput,
  readDesktopConnectionSettings,
  sanitizePersistedDesktopConnectionSettings,
  writeDesktopConnectionSettings,
} from "./desktopConnection";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStateDir(): string {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-desktop-connection-"));
  tempDirs.push(dir);
  return dir;
}

describe("normalizeDesktopRemoteUrl", () => {
  it("normalizes bare hosts to websocket URLs", () => {
    expect(normalizeDesktopRemoteUrl("example.com:3773?token=abc")).toBe(
      "ws://example.com:3773/?token=abc",
    );
  });

  it("converts https URLs to secure websocket URLs", () => {
    expect(normalizeDesktopRemoteUrl("https://example.com/t3?token=abc#ignored")).toBe(
      "wss://example.com/t3?token=abc",
    );
  });

  it("rejects unsupported protocols", () => {
    expect(() => normalizeDesktopRemoteUrl("ftp://example.com")).toThrow(
      "Remote host URLs must use ws://, wss://, http://, or https://.",
    );
  });
});

describe("desktop connection settings helpers", () => {
  it("parses renderer payloads and rejects invalid modes", () => {
    expect(
      parseDesktopConnectionSettingsInput({
        mode: "remote",
        remoteUrl: "wss://example.com",
      }),
    ).toEqual({
      mode: "remote",
      remoteUrl: "wss://example.com",
    });

    expect(() => parseDesktopConnectionSettingsInput({ mode: "invalid" })).toThrow(
      "Desktop connection mode must be 'local' or 'remote'.",
    );
  });

  it("falls back to local mode when persisted remote settings are invalid", () => {
    expect(
      sanitizePersistedDesktopConnectionSettings({
        mode: "remote",
        remoteUrl: "not a url",
      }),
    ).toEqual({
      mode: "local",
      remoteUrl: "not a url",
    });
  });

  it("reads defaults when no settings file exists", () => {
    const stateDir = makeTempStateDir();

    expect(readDesktopConnectionSettings(stateDir)).toEqual(DEFAULT_DESKTOP_CONNECTION_SETTINGS);
  });

  it("writes normalized remote settings to disk", () => {
    const stateDir = makeTempStateDir();

    const written = writeDesktopConnectionSettings(stateDir, {
      mode: "remote",
      remoteUrl: "https://example.com:3773?token=abc",
    });

    expect(written).toEqual({
      mode: "remote",
      remoteUrl: "wss://example.com:3773/?token=abc",
    });
    expect(readDesktopConnectionSettings(stateDir)).toEqual(written);
    expect(isRemoteDesktopConnection(written)).toBe(true);
  });

  it("preserves the last remote URL draft while local mode is active", () => {
    const stateDir = makeTempStateDir();

    const written = writeDesktopConnectionSettings(stateDir, {
      mode: "local",
      remoteUrl: "wss://example.com/?token=abc",
    });

    expect(written).toEqual({
      mode: "local",
      remoteUrl: "wss://example.com/?token=abc",
    });
  });
});
