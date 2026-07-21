import type { MessageId, OrchestrationCheckpointSummary } from "@t3tools/contracts";

export function clearCheckpointAssistantMessageReferences(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  messageId: MessageId,
): OrchestrationCheckpointSummary[] {
  return checkpoints.map((checkpoint) =>
    checkpoint.assistantMessageId === messageId
      ? { ...checkpoint, assistantMessageId: null }
      : checkpoint,
  );
}
