import * as FS from "node:fs";
import * as Path from "node:path";

import type { DesktopConnectionMode, DesktopConnectionSettings } from "@t3tools/contracts";

const DESKTOP_CONNECTION_SETTINGS_FILE = "desktop-connection.json";
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

export const DEFAULT_DESKTOP_CONNECTION_SETTINGS: DesktopConnectionSettings = {
  mode: "local",
  remoteUrl: "",
};

function parseDesktopConnectionMode(value: unknown): DesktopConnectionMode {
  return value === "remote" ? "remote" : "local";
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function withSupportedScheme(rawUrl: string): string {
  return URL_SCHEME_PATTERN.test(rawUrl) ? rawUrl : `ws://${rawUrl}`;
}

export function normalizeDesktopRemoteUrl(rawUrl: string): string {
  const trimmedUrl = rawUrl.trim();
  if (trimmedUrl.length === 0) {
    throw new Error("Enter a remote host URL.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(withSupportedScheme(trimmedUrl));
  } catch {
    throw new Error("Enter a valid remote host URL.");
  }

  if (parsedUrl.protocol === "http:") {
    parsedUrl.protocol = "ws:";
  } else if (parsedUrl.protocol === "https:") {
    parsedUrl.protocol = "wss:";
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw new Error("Remote host URLs must use ws://, wss://, http://, or https://.");
  }

  if (parsedUrl.hostname.trim().length === 0) {
    throw new Error("Remote host URLs must include a hostname.");
  }

  parsedUrl.hash = "";

  if (parsedUrl.pathname.length === 0) {
    parsedUrl.pathname = "/";
  }

  return parsedUrl.toString();
}

export function resolveDesktopConnectionSettingsPath(stateDir: string): string {
  return Path.join(stateDir, DESKTOP_CONNECTION_SETTINGS_FILE);
}

export function parseDesktopConnectionSettingsInput(raw: unknown): DesktopConnectionSettings {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Desktop connection settings payload must be an object.");
  }

  const candidate = raw as Record<string, unknown>;
  const mode = candidate.mode;

  if (mode !== "local" && mode !== "remote") {
    throw new Error("Desktop connection mode must be 'local' or 'remote'.");
  }

  return {
    mode,
    remoteUrl: asTrimmedString(candidate.remoteUrl),
  };
}

export function validateDesktopConnectionSettings(
  input: DesktopConnectionSettings,
): DesktopConnectionSettings {
  const mode = parseDesktopConnectionMode(input.mode);
  const remoteUrl = asTrimmedString(input.remoteUrl);

  if (mode === "remote") {
    return {
      mode,
      remoteUrl: normalizeDesktopRemoteUrl(remoteUrl),
    };
  }

  return {
    mode,
    remoteUrl,
  };
}

export function sanitizePersistedDesktopConnectionSettings(
  raw: unknown,
): DesktopConnectionSettings {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_DESKTOP_CONNECTION_SETTINGS;
  }

  const candidate = raw as Record<string, unknown>;
  const mode = parseDesktopConnectionMode(candidate.mode);
  const remoteUrl = asTrimmedString(candidate.remoteUrl);

  if (mode === "remote") {
    try {
      return {
        mode,
        remoteUrl: normalizeDesktopRemoteUrl(remoteUrl),
      };
    } catch {
      return {
        mode: "local",
        remoteUrl,
      };
    }
  }

  return {
    mode,
    remoteUrl,
  };
}

export function readDesktopConnectionSettings(stateDir: string): DesktopConnectionSettings {
  const settingsPath = resolveDesktopConnectionSettingsPath(stateDir);

  try {
    const parsed = JSON.parse(FS.readFileSync(settingsPath, "utf8")) as unknown;
    return sanitizePersistedDesktopConnectionSettings(parsed);
  } catch {
    return DEFAULT_DESKTOP_CONNECTION_SETTINGS;
  }
}

export function writeDesktopConnectionSettings(
  stateDir: string,
  input: DesktopConnectionSettings,
): DesktopConnectionSettings {
  const normalized = validateDesktopConnectionSettings(input);
  const settingsPath = resolveDesktopConnectionSettingsPath(stateDir);

  FS.mkdirSync(stateDir, { recursive: true });
  FS.writeFileSync(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

  return normalized;
}

export function isRemoteDesktopConnection(settings: DesktopConnectionSettings): boolean {
  return settings.mode === "remote";
}
