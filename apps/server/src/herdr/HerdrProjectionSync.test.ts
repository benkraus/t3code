import { CommandId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  herdrThreadVisibilityAction,
  isLegacyHerdrProjectionThread,
} from "./HerdrProjectionSync.ts";

const instanceId = ProviderInstanceId.make("herdr");
const archiveCommandId = CommandId.make("herdr-thread-archive:1");

function thread(input: {
  readonly id: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}) {
  return {
    id: ThreadId.make(input.id),
    archivedAt: input.archivedAt ?? null,
    deletedAt: input.deletedAt ?? null,
  };
}

const visible = { archiveCommandId: null, autoArchivedAt: null } as const;
const pending = { archiveCommandId, autoArchivedAt: null } as const;
const autoArchived = {
  archiveCommandId,
  autoArchivedAt: "2026-07-21T00:01:00.000Z",
} as const;

describe("external projection visibility", () => {
  it("recognizes ownership from the external session rather than model selection", () => {
    expect(
      isLegacyHerdrProjectionThread(
        {
          id: ThreadId.make("herdr-thread-projected"),
          session: {
            providerName: ProviderDriverKind.make("herdr"),
            providerInstanceId: instanceId,
          },
        },
        instanceId,
      ),
    ).toBe(true);
    expect(
      isLegacyHerdrProjectionThread(
        { id: ThreadId.make("herdr-thread-without-session"), session: null },
        instanceId,
      ),
    ).toBe(false);
    expect(
      isLegacyHerdrProjectionThread(
        {
          id: ThreadId.make("herdr-thread-legacy-default"),
          session: {
            providerName: ProviderDriverKind.make("herdr"),
          },
        },
        instanceId,
      ),
    ).toBe(true);
    expect(
      isLegacyHerdrProjectionThread(
        {
          id: ThreadId.make("herdr-thread-foreign"),
          session: {
            providerName: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        },
        instanceId,
      ),
    ).toBe(false);
    expect(
      isLegacyHerdrProjectionThread(
        {
          id: ThreadId.make("ordinary-t3-thread"),
          session: {
            providerName: ProviderDriverKind.make("herdr"),
            providerInstanceId: instanceId,
          },
        },
        instanceId,
      ),
    ).toBe(false);
  });

  it("archives owned threads whose panes are no longer live", () => {
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "stale" }),
        isLive: false,
        visibility: visible,
      }),
    ).toBe("archive");
  });

  it("recovers pending commands before deciding whether to unarchive", () => {
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "pending-archive", archivedAt: "2026-07-21T00:01:00.000Z" }),
        isLive: true,
        visibility: pending,
      }),
    ).toBe("recover-archive");
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "cancel-pending" }),
        isLive: true,
        visibility: pending,
      }),
    ).toBe("clear-auto-archive");
  });

  it("restores only a completed sync archive when its pane returns", () => {
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "live", archivedAt: "2026-07-21T00:01:00.000Z" }),
        isLive: true,
        visibility: autoArchived,
      }),
    ).toBe("unarchive");
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "manual-archive", archivedAt: "2026-07-21T00:01:00.000Z" }),
        isLive: true,
        visibility: visible,
      }),
    ).toBeNull();
  });

  it("rearchives an auto-archived thread manually restored while its pane is absent", () => {
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "restored-but-missing" }),
        isLive: false,
        visibility: autoArchived,
      }),
    ).toBe("archive");
  });

  it("leaves deleted and currently visible threads unchanged", () => {
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "deleted", deletedAt: "2026-07-21T00:02:00.000Z" }),
        isLive: false,
        visibility: visible,
      }),
    ).toBeNull();
    expect(
      herdrThreadVisibilityAction({
        thread: thread({ id: "live" }),
        isLive: true,
        visibility: visible,
      }),
    ).toBeNull();
  });
});
