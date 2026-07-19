import { useAtomValue } from "@effect/atom-react";
import { MessageId, type EnvironmentId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { createContext, memo, use, useMemo, type PropsWithChildren } from "react";

import { extractHerdrLiveAssistantMarkdown } from "../../herdr/liveTranscript";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { herdrEnvironment } from "../../state/herdr";

const HerdrLiveTimelineEntryContext = createContext<TimelineEntry | null>(null);

export function useHerdrLiveTimelineEntry(): TimelineEntry | null {
  return use(HerdrLiveTimelineEntryContext);
}

interface HerdrLiveTimelineProviderProps extends PropsWithChildren {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly latestUserMessage: ChatMessage | null;
  readonly runningTurnId: TurnId | null;
  readonly isWorking: boolean;
  readonly hasCanonicalAssistant: boolean;
}

export const HerdrLiveTimelineProvider = memo(function HerdrLiveTimelineProvider({
  enabled,
  children,
  ...props
}: HerdrLiveTimelineProviderProps) {
  if (!enabled) return children;
  return <ActiveHerdrLiveTimelineProvider {...props}>{children}</ActiveHerdrLiveTimelineProvider>;
});

const ActiveHerdrLiveTimelineProvider = memo(function ActiveHerdrLiveTimelineProvider({
  environmentId,
  threadId,
  latestUserMessage,
  runningTurnId,
  isWorking,
  hasCanonicalAssistant,
  children,
}: Omit<HerdrLiveTimelineProviderProps, "enabled">) {
  const atom = useMemo(
    () => herdrEnvironment.pane({ environmentId, input: { threadId } }),
    [environmentId, threadId],
  );
  const result = useAtomValue(atom);
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const entry = useMemo<TimelineEntry | null>(() => {
    if (!isWorking || hasCanonicalAssistant || !latestUserMessage || !snapshot) return null;
    const text = extractHerdrLiveAssistantMarkdown(snapshot.text, latestUserMessage.text);
    if (!text) return null;
    const messageId = MessageId.make(`herdr-live:${threadId}`);
    const message: ChatMessage = {
      id: messageId,
      role: "assistant",
      text,
      turnId: runningTurnId,
      streaming: true,
      createdAt: snapshot.updatedAt,
      updatedAt: snapshot.updatedAt,
    };
    return {
      id: messageId,
      kind: "message",
      createdAt: snapshot.updatedAt,
      message,
    };
  }, [hasCanonicalAssistant, isWorking, latestUserMessage, runningTurnId, snapshot, threadId]);

  return <HerdrLiveTimelineEntryContext value={entry}>{children}</HerdrLiveTimelineEntryContext>;
});
