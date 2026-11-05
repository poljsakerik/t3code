import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";

import { releasedThread } from "./DeviceReleaseReactor.ts";

const threadId = ThreadId.make("thread-1");
// Only the fields the release rule reads; the rest of each event is irrelevant here.
const event = (type: string, payload: object = {}) =>
  ({ type, threadId, payload }) as unknown as OrchestrationV2DomainEvent;

describe("releasedThread", () => {
  it.each(["completed", "interrupted", "failed", "cancelled"])(
    "releases when a run ends as %s",
    (status) => {
      expect(releasedThread(event("run.updated", { status }))).toBe(threadId);
    },
  );

  it.each(["running", "waiting", "queued", "starting"])(
    "keeps devices while a run is %s",
    (status) => {
      expect(releasedThread(event("run.updated", { status }))).toBeUndefined();
    },
  );

  it.each(["thread.settled", "thread.archived", "thread.deleted"])("releases on %s", (type) => {
    expect(releasedThread(event(type))).toBe(threadId);
  });

  it.each(["thread.pinned", "thread.visited", "run.created"])("ignores %s", (type) => {
    expect(releasedThread(event(type, { status: "completed" }))).toBeUndefined();
  });
});
