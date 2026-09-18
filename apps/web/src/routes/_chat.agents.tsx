import { useAtomRefresh } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, FileText, Folder, GitBranch, Globe, Pencil, Plus, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import type { AgentDefinition, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { AgentEditorDialog } from "../components/AgentEditorDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

export const Route = createFileRoute("/_chat/agents")({ component: AgentsPage });

interface AgentScope {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  label: string;
}

function AgentsPage() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const showEnvironment = environments.length > 1;
  const [createScope, setCreateScope] = useState<AgentScope | null>(null);
  const scopes: AgentScope[] = [
    ...environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: showEnvironment ? `Global · ${environment.label}` : "Global",
    })),
    ...projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
      label: showEnvironment
        ? `${project.title} · ${environmentLabels.get(project.environmentId) ?? project.environmentId}`
        : project.title,
    })),
  ];

  return (
    <main className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-5xl space-y-8">
        <header className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
            {scopes.length > 0 ? (
              <Menu>
                <MenuTrigger render={<Button size="sm" />}>
                  <Plus aria-hidden className="size-3.5" />
                  Create agent
                </MenuTrigger>
                <MenuPopup
                  align="end"
                  aria-label="Create agent in"
                  className="max-h-80 overflow-y-auto"
                >
                  {scopes.map((scope) => (
                    <MenuItem
                      key={JSON.stringify([scope.environmentId, scope.projectId])}
                      onClick={() => setCreateScope(scope)}
                    >
                      {scope.projectId === undefined ? (
                        <Globe aria-hidden />
                      ) : (
                        <Folder aria-hidden />
                      )}
                      {scope.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
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
        {createScope ? (
          <CreateAgentDialog scope={createScope} onClose={() => setCreateScope(null)} />
        ) : null}
        {environments.length === 0 && projects.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            Connect to an environment to see its agents.
          </p>
        ) : null}
      </div>
    </main>
  );
}

function CreateAgentDialog({ scope, onClose }: { scope: AgentScope; onClose: () => void }) {
  const catalog = useEnvironmentQuery(
    projectEnvironment.agentDefinitions({
      environmentId: scope.environmentId,
      input: scope.projectId === undefined ? {} : { projectId: scope.projectId },
    }),
  );
  const refreshGlobal = useAtomRefresh(
    projectEnvironment.agentDefinitions({
      environmentId: scope.environmentId,
      input: {},
    }),
  );
  return (
    <AgentEditorDialog
      environmentId={scope.environmentId}
      {...(scope.projectId === undefined ? {} : { projectId: scope.projectId })}
      agent={null}
      parent={
        catalog.data?.agents.find((agent) => agent.id === ".t3" || agent.id === ".t3/agent") ?? null
      }
      scopeLabel={scope.label}
      onClose={onClose}
      onSaved={() => {
        catalog.refresh();
        // A project registered at home is displayed by the Global catalog.
        if (scope.projectId !== undefined && catalog.data?.scope === "global") refreshGlobal();
        onClose();
      }}
    />
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
  const [editor, setEditor] = useState<{ agent: AgentDefinition | null } | null>(null);
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
  const singleRoot = agents.find((agent) => agent.id === ".t3" || agent.id === ".t3/agent") ?? null;

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
          variant="outline"
          disabled={!catalog.isSuccess}
          onClick={() => setEditor({ agent: null })}
        >
          <Plus aria-hidden className="size-3.5" />
          Create agent
        </Button>
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
              onEdit={() => setEditor({ agent })}
              parentName={
                agent.parentId ? (agentNames.get(agent.parentId) ?? agent.parentId) : null
              }
            />
          ))}
        </ul>
      ) : null}
      {editor ? (
        <AgentEditorDialog
          environmentId={environmentId}
          {...(projectId === undefined ? {} : { projectId })}
          agent={editor.agent}
          parent={singleRoot}
          scopeLabel={environmentLabel ? `${title} · ${environmentLabel}` : title}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            catalog.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function AgentCard({
  agent,
  parentName,
  onEdit,
}: {
  agent: AgentDefinition;
  parentName: string | null;
  onEdit: () => void;
}) {
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-xs">
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
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
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={onEdit}
          aria-label={`Edit ${agent.name}`}
        >
          <Pencil aria-hidden className="size-3.5" />
          Edit agent
        </Button>
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
