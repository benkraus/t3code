function resolveWindowHost(): string {
  if (typeof window === "undefined") {
    return "";
  }

  if (window.location.host.length > 0) {
    return window.location.host;
  }

  if (window.location.port.length > 0) {
    return `${window.location.hostname}:${window.location.port}`;
  }

  return window.location.hostname;
}

export function resolveConfiguredWsUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const bridgeUrl = window.desktopBridge?.getWsUrl?.();
  if (typeof bridgeUrl === "string" && bridgeUrl.length > 0) {
    return bridgeUrl;
  }

  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (typeof envUrl === "string" && envUrl.length > 0) {
    return envUrl;
  }

  return null;
}

export function resolveWebSocketUrl(): string {
  const configuredUrl = resolveConfiguredWsUrl();
  if (configuredUrl) {
    return configuredUrl;
  }

  if (typeof window === "undefined") {
    return "";
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${resolveWindowHost()}`;
}

export function resolveServerHttpOrigin(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const wsUrl = resolveWebSocketUrl();
  try {
    const parsedUrl = new URL(wsUrl);
    const protocol =
      parsedUrl.protocol === "wss:"
        ? "https:"
        : parsedUrl.protocol === "ws:"
          ? "http:"
          : parsedUrl.protocol;
    return `${protocol}//${parsedUrl.host}`;
  } catch {
    return window.location.origin;
  }
}
