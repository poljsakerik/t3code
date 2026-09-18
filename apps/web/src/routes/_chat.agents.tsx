import { createFileRoute } from "@tanstack/react-router";
import { Bot, FileText, Folder, GitBranch, Globe, RefreshCw } from "lucide-react";
import { useId } from "react";
import type { AgentDefinition, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

export const Route = createFileRoute("/_chat/agents")({ component: AgentsPage });

function AgentsPage() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const showEnvironment = environments.length > 1;

  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Your Eve agents, organized by project. Agents in your home directory appear under
            Global.
          </p>
        </header>
        {environments.map((environment) => (
          <AgentCatalog
            key={environment.environmentId}
            environmentId={environment.environmentId}
            title="Global"
            directory="~/.t3"
            environmentLabel={showEnvironment ? environment.label : null}
          />
        ))}
        {projects.map((project) => (
          <AgentCatalog
            key={JSON.stringify([project.environmentId, project.id])}
            environmentId={project.environmentId}
            projectId={project.id}
            title={project.title}
            directory={project.workspaceRoot}
            environmentLabel={
              showEnvironment
                ? (environmentLabels.get(project.environmentId) ?? project.environmentId)
                : null
            }
          />
        ))}
        {environments.length === 0 && projects.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            Connect to an environment to see its agents.
          </p>
        ) : null}
      </div>
    </main>
  );
}

function AgentCatalog({
  environmentId,
  projectId,
  title,
  directory,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  title: string;
  directory: string;
  environmentLabel: string | null;
}) {
  const headingId = useId();
  const catalog = useEnvironmentQuery(
    projectEnvironment.agentDefinitions({
      environmentId,
      input: projectId === undefined ? {} : { projectId },
    }),
  );
  // A registered home directory is already represented by this environment's Global group.
  if (projectId !== undefined && catalog.data?.scope === "global") return null;

  const agents = catalog.data?.agents ?? [];
  if (catalog.isSuccess && agents.length === 0) return null;

  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const Icon = projectId === undefined ? Globe : Folder;

  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
          <Icon aria-hidden className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 id={headingId} className="truncate text-sm font-semibold">
              {title}
            </h2>
            {catalog.data ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {agents.length} {agents.length === 1 ? "agent" : "agents"}
              </span>
            ) : null}
            {environmentLabel ? (
              <Badge variant="secondary" size="sm" className="max-w-full truncate">
                {environmentLabel}
              </Badge>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger render={<p />} className="truncate text-xs text-muted-foreground">
              {directory}
            </TooltipTrigger>
            <TooltipPopup className="max-w-80 break-all">{directory}</TooltipPopup>
          </Tooltip>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={catalog.refresh}
          disabled={catalog.isPending}
          aria-label={`Refresh ${title} agents${environmentLabel ? ` on ${environmentLabel}` : ""}`}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          Refresh
        </Button>
      </div>
      {catalog.error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive-foreground"
        >
          {catalog.error}
        </p>
      ) : null}
      {catalog.isPending && !catalog.data ? (
        <p
          role="status"
          className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground"
        >
          Loading agents…
        </p>
      ) : null}
      {agents.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              parentName={
                agent.parentId ? (agentNames.get(agent.parentId) ?? agent.parentId) : null
              }
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AgentCard({ agent, parentName }: { agent: AgentDefinition; parentName: string | null }) {
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="break-words text-sm font-semibold">{agent.name}</h3>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              {parentName ? (
                <>
                  <GitBranch aria-hidden className="size-3 shrink-0" />
                  <span className="break-words">Subagent of {parentName}</span>
                </>
              ) : (
                "Eve agent"
              )}
            </p>
          </div>
        </div>
        {agent.slots.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {agent.slots.map((slot) => (
              <Badge key={slot} variant="secondary" size="sm" className="capitalize">
                {slot}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <FileText aria-hidden className="size-3.5" />
            {agent.instructionPaths.length > 0
              ? `${agent.instructionPaths.length} instruction ${agent.instructionPaths.length === 1 ? "source" : "sources"}`
              : "No instructions"}
          </span>
          {agent.configurationPath ? <span>Configured</span> : null}
        </div>
      </div>
      <div className="border-t border-border/50 bg-muted/20 px-4 py-2.5">
        <Tooltip>
          <TooltipTrigger
            render={<p />}
            className="truncate font-mono text-[11px] text-muted-foreground"
          >
            {agent.directory}
          </TooltipTrigger>
          <TooltipPopup className="max-w-80 break-all">{agent.directory}</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
}
