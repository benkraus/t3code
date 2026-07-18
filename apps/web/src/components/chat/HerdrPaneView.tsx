import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { LoaderCircleIcon, RefreshCwIcon, TerminalIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";

import { herdrEnvironment } from "../../state/herdr";
import { Button } from "../ui/button";

interface HerdrPaneViewProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly bottomInset: number;
}

export const HerdrPaneView = memo(function HerdrPaneView({
  environmentId,
  threadId,
  bottomInset,
}: HerdrPaneViewProps) {
  const atom = useMemo(
    () => herdrEnvironment.pane({ environmentId, input: { threadId } }),
    [environmentId, threadId],
  );
  const result = useAtomValue(atom);
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || snapshot === null) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [snapshot?.revision, snapshot?.text]);

  if (snapshot === null && result._tag === "Failure") {
    const error = Cause.squash(result.cause);
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-md space-y-3">
          <TerminalIcon className="mx-auto size-6 text-muted-foreground" />
          <p className="text-sm text-foreground">HerdR pane unavailable</p>
          <p className="text-xs text-muted-foreground">
            {error instanceof Error ? error.message : "The external runtime is disconnected."}
          </p>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            <RefreshCwIcon />
            Reconnect
          </Button>
        </div>
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
        <LoaderCircleIcon className="size-4 animate-spin" />
        Connecting to HerdR
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className="min-h-0 flex-1 overflow-auto overscroll-contain px-3 pt-3 sm:px-5 sm:pt-4"
      style={{ paddingBottom: Math.max(bottomInset + 16, 32) }}
      data-herdr-pane-view="true"
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs">
          <TerminalIcon className="size-3.5" />
          <span>{snapshot.binding.agent ?? "shell"}</span>
          <span aria-hidden="true">/</span>
          <span className="truncate">{snapshot.binding.cwd}</span>
          <span className="ml-auto capitalize">{snapshot.binding.status}</span>
        </div>
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-foreground sm:text-[13px]">
          {snapshot.text || "Waiting for terminal output..."}
        </pre>
      </div>
    </div>
  );
});
