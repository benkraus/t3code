function serializeSearchValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  return JSON.stringify(value);
}

function parseSearchValue(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

export function parseQuerySearch(search: string): Record<string, unknown> {
  const trimmed = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(trimmed);
  const parsed: Record<string, unknown> = {};

  for (const [key, value] of params.entries()) {
    parsed[key] = parseSearchValue(value);
  }

  return parsed;
}

export function stringifyQuerySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) {
      continue;
    }

    params.set(key, serializeSearchValue(value));
  }

  const query = params.toString();
  if (query.length === 0) {
    return "";
  }

  return `?${query}`;
}
