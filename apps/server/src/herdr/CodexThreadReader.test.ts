import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  readCodexThread,
  type CodexThreadReaderClient,
  type CodexThreadSnapshot,
} from "./CodexThreadReader.ts";

const thread = {
  id: "thread-1",
  sessionId: "thread-1",
  turns: [],
} as unknown as CodexThreadSnapshot;

describe("readCodexThread", () => {
  it.effect("resumes a persisted thread when thread/read reports it is not loaded", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        request: (method: "thread/read" | "thread/resume") => {
          calls.push(method);
          return method === "thread/read"
            ? Effect.fail(
                new CodexErrors.CodexAppServerRequestError({
                  code: -32600,
                  errorMessage: "thread not loaded: thread-1",
                  method,
                }),
              )
            : Effect.succeed({ thread } as never);
        },
      } as CodexThreadReaderClient;

      expect(yield* readCodexThread(client, "thread-1")).toBe(thread);
      expect(calls).toEqual(["thread/read", "thread/resume"]);
    }),
  );

  it.effect("does not resume for unrelated read failures", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const failure = new CodexErrors.CodexAppServerRequestError({
        code: -32603,
        errorMessage: "Permission denied",
        method: "thread/read",
      });
      const client = {
        request: (method: "thread/read" | "thread/resume") => {
          calls.push(method);
          return Effect.fail(failure);
        },
      } as CodexThreadReaderClient;

      expect(yield* readCodexThread(client, "thread-1").pipe(Effect.flip)).toBe(failure);
      expect(calls).toEqual(["thread/read"]);
    }),
  );

  it.effect("falls back when the reported thread does not exist", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        request: (method: "thread/read" | "thread/resume", payload: { threadId: string }) => {
          calls.push(`${method}:${payload.threadId}`);
          if (payload.threadId === "reported-session") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "Thread does not exist",
                method,
              }),
            );
          }
          return method === "thread/read"
            ? Effect.fail(
                new CodexErrors.CodexAppServerRequestError({
                  code: -32600,
                  errorMessage: "thread not loaded: projected-session",
                  method,
                }),
              )
            : Effect.succeed({ thread } as never);
        },
      } as CodexThreadReaderClient;

      expect(yield* readCodexThread(client, "reported-session", "projected-session")).toBe(thread);
      expect(calls).toEqual([
        "thread/read:reported-session",
        "thread/read:projected-session",
        "thread/resume:projected-session",
      ]);
    }),
  );

  it.effect("falls back to the last projected session when HerdR reports a transient id", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        request: (method: "thread/read" | "thread/resume", payload: { threadId: string }) => {
          calls.push(`${method}:${payload.threadId}`);
          if (method === "thread/read") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32600,
                errorMessage: `thread not loaded: ${payload.threadId}`,
                method,
              }),
            );
          }
          if (payload.threadId === "reported-session") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32600,
                errorMessage: "no rollout found for thread id reported-session",
                method,
              }),
            );
          }
          return Effect.succeed({ thread } as never);
        },
      } as CodexThreadReaderClient;

      expect(yield* readCodexThread(client, "reported-session", "projected-session")).toBe(thread);
      expect(calls).toEqual([
        "thread/read:reported-session",
        "thread/resume:reported-session",
        "thread/read:projected-session",
        "thread/resume:projected-session",
      ]);
    }),
  );
});
