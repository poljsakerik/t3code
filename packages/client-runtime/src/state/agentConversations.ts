import type {
  AgentConversationOwner,
  AgentDefinitionsListResult,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";

export function buildAgentConversationData<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "agent" | "deletedAt">,
>({
  environmentId,
  sourceProjectId,
  threads,
  catalog,
}: {
  environmentId: EnvironmentId;
  sourceProjectId: ProjectId | null;
  threads: ReadonlyArray<T>;
  catalog: AgentDefinitionsListResult | null | undefined;
}) {
  const conversations = threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.agent?.sourceProjectId === sourceProjectId &&
      thread.deletedAt === null,
  );
  const definitions =
    sourceProjectId !== null && catalog?.scope === "global" ? [] : (catalog?.agents ?? []);
  const owners = new Map<string, AgentConversationOwner>();
  for (const thread of conversations)
    if (thread.agent) owners.set(thread.agent.agentId, thread.agent);
  for (const definition of definitions)
    owners.set(definition.id, { agentId: definition.id, name: definition.name, sourceProjectId });
  return { conversations, definitions, owners };
}

export function buildAgentConversationScopes({
  environmentId,
  projects,
  threads,
  archivedThreads,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>;
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "agent">>;
  archivedThreads: ReadonlyArray<Pick<EnvironmentThreadShell, "agent">>;
}) {
  const scopes = new Map<ProjectId | null, { label: string; available: boolean }>([
    [null, { label: "Global", available: true }],
  ]);
  for (const project of projects)
    if (project.environmentId === environmentId)
      scopes.set(project.id, { label: project.title, available: true });
  for (const thread of [
    ...threads.filter((thread) => thread.environmentId === environmentId),
    ...archivedThreads,
  ])
    if (thread.agent && !scopes.has(thread.agent.sourceProjectId))
      scopes.set(thread.agent.sourceProjectId, { label: "Removed project", available: false });
  return scopes;
}
