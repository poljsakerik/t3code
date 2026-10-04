import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  agentConversationRefFromHref,
  resolveAgentConversationHref,
} from "./agentConversationNavigation.logic";

const thread = {
  environmentId: EnvironmentId.make("local"),
  id: ThreadId.make("ponytail"),
  agent: { agentId: ".t3/agents/Ponytail", name: "Ponytail", sourceProjectId: null },
  archivedAt: null,
  deletedAt: null,
};

describe("Agents tab destination", () => {
  it("resumes an available agent conversation", () => {
    expect(resolveAgentConversationHref("/local/ponytail", thread)).toBe("/local/ponytail");
  });

  it("opens the Agents list after the previous conversation was archived", () => {
    expect(
      resolveAgentConversationHref("/local/ponytail", {
        ...thread,
        archivedAt: "2026-09-22T16:00:00Z",
      }),
    ).toBe("/agents");
  });

  it("opens the Agents list for missing or deleted conversations", () => {
    expect(resolveAgentConversationHref("/local/ponytail", null)).toBe("/agents");
    expect(
      resolveAgentConversationHref("/local/ponytail", {
        ...thread,
        deletedAt: "2026-09-22T16:00:00Z",
      }),
    ).toBe("/agents");
  });

  it("does not resume a code thread or a thread from another environment", () => {
    expect(resolveAgentConversationHref("/local/ponytail", { ...thread, agent: undefined })).toBe(
      "/agents",
    );
    expect(resolveAgentConversationHref("/remote/ponytail", thread)).toBe("/agents");
    expect(resolveAgentConversationHref("/local/another-thread", thread)).toBe("/agents");
  });

  it("handles encoded thread IDs and invalid remembered destinations", () => {
    const encoded = { ...thread, id: ThreadId.make("thread:agent/review") };
    expect(resolveAgentConversationHref("/local/thread%3Aagent%2Freview", encoded)).toBe(
      "/local/thread%3Aagent%2Freview",
    );
    for (const href of [
      "/agents",
      "/",
      "/local/%broken",
      "/draft/draft-one",
      "https://example.com/thread",
    ]) {
      expect(resolveAgentConversationHref(href, thread)).toBe("/agents");
    }
    expect(agentConversationRefFromHref("/local/%broken")).toBeNull();
  });
});
