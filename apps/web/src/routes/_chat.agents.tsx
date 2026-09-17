import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/_chat/agents")({ component: AgentsPage });

function AgentsPage() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<string | null>(null);
  const keyOf = (project: (typeof projects)[number]) =>
    JSON.stringify([project.environmentId, project.id]);
  const project = projects.find((entry) => keyOf(entry) === selected) ?? projects[0];
  return (
    <main className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <h1 className="text-xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Eve agents from your project's .t3 folder. This catalog lists definitions; running them is
          not available yet.
        </p>
        {project ? (
          <>
            <label className="flex flex-col gap-2 text-sm">
              Project
              <select
                className="rounded-md border bg-background p-2"
                value={keyOf(project)}
                onChange={(event) => setSelected(event.target.value)}
              >
                {projects.map((entry) => (
                  <option key={keyOf(entry)} value={keyOf(entry)}>
                    {entry.title} ·{" "}
                    {environments.find(
                      (environment) => environment.environmentId === entry.environmentId,
                    )?.label ?? entry.environmentId}{" "}
                    · {entry.workspaceRoot}
                  </option>
                ))}
              </select>
            </label>
            <AgentCatalog
              key={keyOf(project)}
              environmentId={project.environmentId}
              projectId={project.id}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Add a project to see its agents.</p>
        )}
      </div>
    </main>
  );
}

function AgentCatalog({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const catalog = useEnvironmentQuery(
    projectEnvironment.agentDefinitions({ environmentId, input: { projectId } }),
  );
  return (
    <section className="space-y-3" aria-label="Available agents">
      <Button size="sm" variant="outline" onClick={catalog.refresh}>
        Refresh
      </Button>
      {catalog.error ? (
        <p role="alert" className="text-sm text-destructive">
          {catalog.error}
        </p>
      ) : null}
      {catalog.isPending && !catalog.data ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : null}
      {catalog.isSuccess && catalog.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents found. Add .t3/agents/&lt;name&gt;/instructions.md and place nested agents in
          subagents/.
        </p>
      ) : null}
      <ul className="space-y-2">
        {catalog.data?.map((agent) => (
          <li
            key={agent.id}
            className="rounded-md border p-3"
            style={{
              marginLeft: Math.min(agent.directory.split("/subagents/").length - 1, 6) * 16,
            }}
          >
            <div className="text-sm font-medium">{agent.name}</div>
            <div className="break-all text-xs text-muted-foreground">{agent.directory}</div>
            {agent.parentId ? (
              <div className="break-all text-xs text-muted-foreground">
                Parent: {agent.parentId}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
