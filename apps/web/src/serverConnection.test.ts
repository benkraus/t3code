import { beforeEach, describe, expect, it } from "vitest";

import {
  resolveConfiguredWsUrl,
  resolveServerHttpOrigin,
  resolveWebSocketUrl,
} from "./serverConnection";

type TestWindow = Window &
  typeof globalThis & {
    desktopBridge?: {
      getWsUrl?: () => string | null;
    };
  };

function setTestWindow(windowValue: TestWindow) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowValue,
  });
}

beforeEach(() => {
  setTestWindow({
    location: {
      protocol: "http:",
      hostname: "localhost",
      host: "localhost:3020",
      port: "3020",
      origin: "http://localhost:3020",
    },
    desktopBridge: undefined,
  } as unknown as TestWindow);
});

describe("serverConnection", () => {
  it("prefers the desktop bridge websocket URL when present", () => {
    setTestWindow({
      location: {
        protocol: "http:",
        hostname: "localhost",
        host: "localhost:3020",
        port: "3020",
        origin: "http://localhost:3020",
      },
      desktopBridge: {
        getWsUrl: () => "wss://remote.example.com/?token=abc",
      },
    } as unknown as TestWindow);

    expect(resolveConfiguredWsUrl()).toBe("wss://remote.example.com/?token=abc");
    expect(resolveWebSocketUrl()).toBe("wss://remote.example.com/?token=abc");
    expect(resolveServerHttpOrigin()).toBe("https://remote.example.com");
  });

  it("falls back to the current browser location", () => {
    expect(resolveConfiguredWsUrl()).toBeNull();
    expect(resolveWebSocketUrl()).toBe("ws://localhost:3020");
    expect(resolveServerHttpOrigin()).toBe("http://localhost:3020");
  });
});
