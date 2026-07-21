import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadRefs } from "../state/entities";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const activeThreadRefs = useThreadRefs();
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const activeThreadMembershipKey = useMemo(() => {
    const includedEnvironmentIds = new Set(environmentIds);
    return activeThreadRefs
      .filter((ref) => includedEnvironmentIds.has(ref.environmentId))
      .map((ref) => `${ref.environmentId}:${ref.threadId}`)
      .toSorted()
      .join("\n");
  }, [activeThreadRefs, environmentIds]);
  const previousActiveThreadMembershipKey = useRef(activeThreadMembershipKey);
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  useEffect(() => {
    if (previousActiveThreadMembershipKey.current === activeThreadMembershipKey) return;
    previousActiveThreadMembershipKey.current = activeThreadMembershipKey;
    refresh();
  }, [activeThreadMembershipKey, refresh]);

  return {
    ...result,
    refresh,
  };
}
