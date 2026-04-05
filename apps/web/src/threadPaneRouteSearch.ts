import { TurnId } from "@t3tools/contracts";

export interface ThreadPaneRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  browser?: "1" | undefined;
  simulator?: "1" | undefined;
}

function isPaneOpenValue(value: unknown): boolean {
  const normalized = normalizeSearchPrimitive(value);
  return normalized === "1" || normalized === 1 || normalized === true;
}

function normalizeSearchPrimitive(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d+(?:\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function normalizeSearchString(value: unknown): string | undefined {
  const normalizedValue = normalizeSearchPrimitive(value);
  if (typeof normalizedValue !== "string") {
    return undefined;
  }
  const normalized = normalizedValue.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function stripBrowserSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "browser"> {
  const { browser: _browser, ...rest } = params;
  return rest as Omit<T, "browser">;
}

export function stripSimulatorSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "simulator"> {
  const { simulator: _simulator, ...rest } = params;
  return rest as Omit<T, "simulator">;
}

export function parseThreadPaneRouteSearch(search: Record<string, unknown>): ThreadPaneRouteSearch {
  const diff = isPaneOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const browser = isPaneOpenValue(search.browser) ? "1" : undefined;
  const simulator = isPaneOpenValue(search.simulator) ? "1" : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(browser ? { browser } : {}),
    ...(simulator ? { simulator } : {}),
  };
}
