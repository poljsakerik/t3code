import { useAtomRefresh } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { Bot, Folder, Globe, Pencil, Plus, RefreshCw, ArrowUpRight } from "lucide-react";
import { useId, useState } from "react";
import type { AgentDefinition, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { AgentEditorDialog } from "../components/AgentEditorDialog";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { useStartAgentConversation } from "../components/AgentConversationSidebar";

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
    <main className="h-full min-w-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <header className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
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
            Start a conversation with an agent. Each brings its own instructions and skills.
          </p>
        </header>
        {environments.map((environment) => (
          <AgentCatalog
            key={environment.environmentId}
            environmentId={environment.environmentId}
            title="Global"
            supported={environment.serverConfig?.agentConversations === true}
            environmentLabel={showEnvironment ? environment.label : null}
          />
        ))}
        {projects.map((project) => (
          <AgentCatalog
            key={JSON.stringify([project.environmentId, project.id])}
            environmentId={project.environmentId}
            projectId={project.id}
            title={project.title}
            supported={
              environments.find(
                (environment) => environment.environmentId === project.environmentId,
              )?.serverConfig?.agentConversations === true
            }
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
  supported,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  title: string;
  supported: boolean;
  environmentLabel: string | null;
}) {
  const headingId = useId();
  const start = useStartAgentConversation();
  const [pending, setPending] = useState<string | null>(null);
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
  if (projectId !== undefined && catalog.isSuccess && agents.length === 0) return null;
  const singleRoot = agents.find((agent) => agent.id === ".t3" || agent.id === ".t3/agent") ?? null;

  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const Icon = projectId === undefined ? Globe : Folder;

  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <h2 id={headingId} className="min-w-0 truncate text-xs font-medium">
          {title}
        </h2>
        {environmentLabel ? <span className="truncate text-xs">· {environmentLabel}</span> : null}
        <div className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={catalog.refresh}
          disabled={catalog.isPending}
          aria-label={`Refresh ${title} agents${environmentLabel ? ` on ${environmentLabel}` : ""}`}
        >
          <RefreshCw aria-hidden className="size-3.5" />
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
        <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onEdit={() => setEditor({ agent })}
              supported={supported}
              pending={pending === agent.id}
              disabled={pending !== null}
              onStart={() => {
                setPending(agent.id);
                void start({
                  environmentId,
                  owner: {
                    agentId: agent.id,
                    name: agent.name,
                    sourceProjectId: projectId ?? null,
                  },
                }).finally(() => setPending(null));
              }}
              parentName={
                agent.parentId ? (agentNames.get(agent.parentId) ?? agent.parentId) : null
              }
            />
          ))}
        </ul>
      ) : null}
      {catalog.isSuccess && agents.length === 0 ? (
        <div className="rounded-lg border border-dashed px-5 py-8">
          <h3 className="text-sm font-medium">Your first agent</h3>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Give an agent instructions and skills you want to use across conversations.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={() => setEditor({ agent: null })}
          >
            <Plus className="size-3.5" />
            Create agent
          </Button>
        </div>
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

function AgentRow({
  agent,
  parentName,
  onEdit,
  onStart,
  supported,
  pending,
  disabled,
}: {
  agent: AgentDefinition;
  parentName: string | null;
  onEdit: () => void;
  onStart: () => void;
  supported: boolean;
  pending: boolean;
  disabled: boolean;
}) {
  const needsModel = agent.configurationPath === null;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap sm:px-5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
        <Bot aria-hidden className="size-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="truncate text-sm font-medium">{agent.name}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {needsModel
            ? "Add a model in agent.ts to start chatting."
            : !supported
              ? "Update this environment to start conversations."
              : parentName
                ? `Inherits from ${parentName}`
                : "Ready to chat"}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${agent.name}`}>
          <Pencil aria-hidden className="size-3.5" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={needsModel || !supported || disabled}
          onClick={onStart}
          aria-label={`Start conversation with ${agent.name}`}
        >
          {pending ? "Starting…" : "Chat"}
          <ArrowUpRight aria-hidden className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}
