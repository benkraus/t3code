import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { isRecoverableThreadResumeError } from "../provider/Layers/CodexSessionRuntime.ts";

const FORCE_KILL_AFTER = "2 seconds" as const;

export type CodexThreadSnapshot = CodexSchema.V2ThreadReadResponse["thread"];

export interface CodexThreadReaderClient {
  readonly request: <M extends "thread/read" | "thread/resume">(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

function isThreadNotLoadedError(error: CodexErrors.CodexAppServerError): boolean {
  return (
    error._tag === "CodexAppServerRequestError" &&
    error.code === -32600 &&
    error.errorMessage.toLowerCase().includes("thread not loaded")
  );
}

const readOrResumeCodexThread = (
  client: CodexThreadReaderClient,
  threadId: string,
): Effect.Effect<CodexThreadSnapshot, CodexErrors.CodexAppServerError> =>
  client.request("thread/read", { threadId, includeTurns: true }).pipe(
    Effect.map((response) => response.thread),
    Effect.catchIf(isThreadNotLoadedError, () =>
      client.request("thread/resume", { threadId }).pipe(Effect.map((response) => response.thread)),
    ),
  );

export const readCodexThread = (
  client: CodexThreadReaderClient,
  threadId: string,
  fallbackThreadId?: string,
): Effect.Effect<CodexThreadSnapshot, CodexErrors.CodexAppServerError> =>
  fallbackThreadId === undefined || fallbackThreadId === threadId
    ? readOrResumeCodexThread(client, threadId)
    : readOrResumeCodexThread(client, threadId).pipe(
        Effect.catchIf(isRecoverableThreadResumeError, () =>
          readOrResumeCodexThread(client, fallbackThreadId),
        ),
      );

export interface CodexThreadReader {
  readonly readThread: (
    threadId: string,
    fallbackThreadId?: string,
  ) => Effect.Effect<CodexThreadSnapshot, CodexErrors.CodexAppServerError>;
}

export const makeCodexThreadReader = Effect.fn("Herdr.makeCodexThreadReader")(function* (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  CodexThreadReader,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const platform = yield* HostProcessPlatform;
  const environment = input.environment ?? process.env;
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, ["app-server"], {
    env: environment,
    extendEnv: input.environment === undefined,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        detached: platform !== "win32",
        env: environment,
        extendEnv: input.environment === undefined,
        forceKillAfter: FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
    Layer.build,
    Effect.provideService(Scope.Scope, scope),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);

  return {
    readThread: (threadId, fallbackThreadId) => readCodexThread(client, threadId, fallbackThreadId),
  };
});
