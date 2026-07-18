import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createHerdrEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  return {
    pane: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:herdr:pane",
      tag: WS_METHODS.subscribeHerdrPane,
      idleTtlMs: 5_000,
    }),
    createThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:herdr:create-thread",
      tag: WS_METHODS.herdrCreateThread,
      scheduler: lifecycleScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.instanceId, input.cwd]),
      },
    }),
    closePane: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:herdr:close-pane",
      tag: WS_METHODS.herdrClosePane,
      scheduler: lifecycleScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}
