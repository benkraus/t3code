import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const HERDR_EVENT_PREFIX = "herdr-codex:";
const HERDR_COMMAND_PATTERN =
  /^provider:(herdr-codex:.*):[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalEventId(eventId: string, streamId: string): string {
  const scopedPrefix = `${HERDR_EVENT_PREFIX}${streamId}:`;
  if (eventId.startsWith(scopedPrefix)) return eventId;
  return `${scopedPrefix}${eventId.slice(HERDR_EVENT_PREFIX.length)}`;
}

export const collectHerdrRuntimeEventReceiptBackfill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly commandId: string;
    readonly processedAt: string;
    readonly streamId: string;
  }>`
    SELECT
      command_id AS "commandId",
      MAX(occurred_at) AS "processedAt",
      stream_id AS "streamId"
    FROM orchestration_events
    WHERE command_id LIKE 'provider:herdr-codex:%'
    GROUP BY command_id, stream_id
  `;
  const receipts = new Map<string, string>();
  const legacyEventIds = new Set<string>();
  for (const row of rows) {
    const legacyEventId = HERDR_COMMAND_PATTERN.exec(row.commandId)?.[1];
    if (!legacyEventId) continue;
    const eventId = canonicalEventId(legacyEventId, row.streamId);
    // Lifecycle events can dispatch multiple commands. A command trail may be
    // partial after an interrupted old process, so replay them instead of
    // seeding an ambiguous receipt that could suppress missing side effects.
    if (eventId.endsWith(":turn:started") || eventId.endsWith(":turn:completed")) {
      continue;
    }
    if (legacyEventId !== eventId) legacyEventIds.add(legacyEventId);
    const previous = receipts.get(eventId);
    if (!previous || previous < row.processedAt) {
      receipts.set(eventId, row.processedAt);
    }
  }
  return { legacyEventIds, receipts } as const;
});
