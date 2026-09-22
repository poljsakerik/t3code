import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type AgentConversationOwner } from "@t3tools/contracts";
import { buildAgentConversationData, buildAgentConversationScopes } from "./agentConversations.ts";

const environmentId = EnvironmentId.make("local");
const otherEnvironment = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const removedProjectId = ProjectId.make("removed");
const owner = { agentId: "writer", name: "Saved writer", sourceProjectId: null };
const definition = {
  id: "writer",
  name: "Current writer",
  directory: "/agents/writer",
  parentId: null,
  configurationPath: null,
  instructionPaths: [],
  slots: [],
};
const conversation = (agent: AgentConversationOwner | undefined = owner) => ({
  environmentId,
  agent,
  deletedAt: null as string | null,
});

describe("agent conversation data", () => {
  it("filters by environment and source scope, retains missing owners, and prefers current names", () => {
    const active = conversation();
    const saved = conversation({ ...owner, agentId: "removed-agent", name: "Removed agent" });
    const { conversations, owners, definitions } = buildAgentConversationData({
      environmentId,
      sourceProjectId: null,
      threads: [
        active,
        saved,
        { ...conversation(), environmentId: otherEnvironment },
        conversation({ ...owner, sourceProjectId: projectId }),
        { ...conversation(), agent: undefined },
        { ...conversation(), deletedAt: "2026-09-22" },
      ],
      catalog: { scope: "global", agents: [definition] },
    });
    expect(conversations).toEqual([active, saved]);
    expect([...owners.values()]).toEqual([{ ...owner, name: "Current writer" }, saved.agent]);
    expect(definitions).toEqual([definition]);
  });

  it("does not advertise fallback global definitions as project agents", () => {
    const saved = conversation({ ...owner, sourceProjectId: projectId });
    const result = buildAgentConversationData({
      environmentId,
      sourceProjectId: projectId,
      threads: [saved],
      catalog: { scope: "global", agents: [definition] },
    });
    expect(result.definitions).toEqual([]);
    expect([...result.owners.values()]).toEqual([saved.agent]);
    expect(
      buildAgentConversationData({
        environmentId,
        sourceProjectId: projectId,
        threads: [saved],
        catalog: undefined,
      }).conversations,
    ).toEqual([saved]);
  });

  it("keeps removed project scopes from active and archived conversations within their environment", () => {
    const archivedProjectId = ProjectId.make("archived-project");
    const scopes = buildAgentConversationScopes({
      environmentId,
      projects: [
        { environmentId, id: projectId, title: "Current project" },
        { environmentId: otherEnvironment, id: ProjectId.make("remote-project"), title: "Remote" },
      ],
      threads: [
        conversation({ ...owner, sourceProjectId: projectId }),
        conversation({ ...owner, sourceProjectId: removedProjectId }),
        {
          ...conversation({ ...owner, sourceProjectId: ProjectId.make("remote-only") }),
          environmentId: otherEnvironment,
        },
      ],
      archivedThreads: [{ agent: { ...owner, sourceProjectId: archivedProjectId } }],
    });
    expect([...scopes]).toEqual([
      [null, { label: "Global", available: true }],
      [projectId, { label: "Current project", available: true }],
      [removedProjectId, { label: "Removed project", available: false }],
      [archivedProjectId, { label: "Removed project", available: false }],
    ]);
  });
});
