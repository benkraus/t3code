import { createHerdrEnvironmentAtoms } from "@t3tools/client-runtime/state/herdr";

import { connectionAtomRuntime } from "../connection/runtime";

export const herdrEnvironment = createHerdrEnvironmentAtoms(connectionAtomRuntime);
