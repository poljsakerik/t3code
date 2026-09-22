import {
  buildAgentConversationData,
  buildAgentConversationScopes,
} from "@t3tools/client-runtime/state/agent-conversations";
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronDown,
  Search,
  SquarePen,
  Settings2,
} from "lucide-react";
import { SidebarHeaderIconButton } from "./sidebar/SidebarThreadHeader";
import { toastManager } from "./ui/toast";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import { useSidebar } from "./ui/sidebar";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { newThreadId } from "../lib/utils";
import { useCallback, useEffect, useState } from "react";
import { useRouter, Link } from "@tanstack/react-router";
import { CommandId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useProjects, useThreadShells, waitForThreadShell } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { orchestrationEnvironment } from "../state/orchestration";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  useAgentConversationNavigation,
  type AgentSelection,
} from "../agentConversationNavigation";
import { SidebarChromeHeader, SidebarChromeFooter } from "./sidebar/SidebarChrome";
import { isElectron } from "../env";
import { Button } from "./ui/button";

export function useStartAgentConversation() {
  const { isMobile, setOpenMobile } = useSidebar();
  const launch = useAtomCommand(
    orchestrationEnvironment.v2.launchThread,
    "start agent conversation",
  );
  const router = useRouter();
  return useCallback(
    async ({ environmentId, owner }: AgentSelection) => {
      const threadId = newThreadId();
      const result = await launch({
        environmentId,
        input: {
          commandId: CommandId.make(newThreadId()),
          threadId,
          agent: { agentId: owner.agentId, sourceProjectId: owner.sourceProjectId },
          title: `Conversation with ${owner.name}`,
          creationSource: "web",
        },
      });
      if (result._tag === "Success") {
        const ready = await waitForThreadShell({ environmentId, threadId });
        if (!ready) {
          toastManager.add({
            type: "error",
            title: "Conversation created, but not loaded",
            description: "Reconnect and open the conversation from the sidebar.",
          });
          return;
        }
        if (isMobile) setOpenMobile(false);
        useAgentConversationNavigation.setState({
          mode: "agents",
          selected: { environmentId, owner },
        });
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not start conversation",
          description:
            error instanceof Error
              ? error.message
              : "Check the agent configuration and environment connection.",
        });
      }
    },
    [launch, router, isMobile, setOpenMobile],
  );
}

export function AgentConversationCommandHandler() {
  const start = useStartAgentConversation();
  const router = useRouter();
  useEffect(() => {
    const handle = () => {
      const selected = useAgentConversationNavigation.getState().selected;
      if (selected) void start(selected);
      else void router.navigate({ to: "/agents" });
    };
    window.addEventListener("t3-new-agent-conversation", handle);
    return () => window.removeEventListener("t3-new-agent-conversation", handle);
  }, [start, router]);
  return null;
}

function AgentScope({
  environmentId,
  sourceProjectId,
  label,
  available,
  supported,
  archived,
  query,
}: {
  environmentId: EnvironmentId;
  sourceProjectId: ProjectId | null;
  label: string;
  available: boolean;
  supported: boolean;
  archived: boolean;
  query: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const catalog = useEnvironmentQuery(
    available
      ? projectEnvironment.agentDefinitions({
          environmentId,
          input: sourceProjectId === null ? {} : { projectId: sourceProjectId },
        })
      : null,
  );
  const archive = useEnvironmentQuery(
    archived ? orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} }) : null,
  );
  const start = useStartAgentConversation();
  const archiveThread = useAtomCommand(threadEnvironment.archive, "archive conversation");
  const restoreThread = useAtomCommand(threadEnvironment.unarchive, "restore conversation");
  const [pending, setPending] = useState<string | null>(null);
  const { conversations, definitions, owners } = buildAgentConversationData({
    environmentId,
    sourceProjectId,
    threads: [
      ...threads,
      ...(archive.data?.threads ?? []).map((thread) => presentThreadShell(environmentId, thread)),
    ],
    catalog: catalog.data,
  });
  if (owners.size === 0 && !catalog.isPending && catalog.error === null) return null;
  return (
    <section className="space-y-1 px-[var(--sidebar-content-inset)] py-2">
      <h2 className="truncate px-2.5 pb-1 text-xs font-medium text-sidebar-muted-foreground">
        {label}
      </h2>
      {catalog.error !== null ? (
        <p className="text-xs text-destructive">
          Could not load agents. <button onClick={() => catalog.refresh()}>Retry</button>
        </p>
      ) : null}
      {query &&
      ![...owners.values()].some((owner) => owner.name.toLowerCase().includes(query)) &&
      !conversations.some((thread) => thread.title.toLowerCase().includes(query)) ? (
        <p className="px-2.5 py-2 text-xs text-sidebar-muted-foreground">
          No matching agents or conversations.
        </p>
      ) : null}
      {[...owners.values()].map((owner) => {
        const definition = definitions.find((definition) => definition.id === owner.agentId);
        const exists = definition !== undefined;
        const needsModel = definition?.configurationPath === null;
        const history = conversations
          .filter((thread) => thread.agent?.agentId === owner.agentId)
          .filter(
            (thread) =>
              owner.name.toLowerCase().includes(query) ||
              thread.title.toLowerCase().includes(query),
          )
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (query && !owner.name.toLowerCase().includes(query) && history.length === 0) return null;
        const expanded = query.length > 0 || !collapsed.has(owner.agentId);
        return (
          <div key={owner.agentId} className="pb-2">
            <div className="group/agent flex h-9 items-center gap-1 rounded-md px-1">
              <button
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm font-medium text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={expanded}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(owner.agentId)) next.delete(owner.agentId);
                    else next.add(owner.agentId);
                    return next;
                  })
                }
              >
                <Bot aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
                <span className="flex-1 truncate">{owner.name}</span>
                <ChevronDown
                  aria-hidden
                  className={`size-3 text-sidebar-muted-foreground ${expanded ? "" : "-rotate-90"}`}
                />
              </button>
              <SidebarHeaderIconButton
                label={`New conversation with ${owner.name}`}
                disabled={!exists || needsModel || !supported || pending !== null}
                tooltip={
                  needsModel
                    ? "Configure a model in agent.ts to start a conversation"
                    : `New conversation with ${owner.name}`
                }
                onClick={() => {
                  setPending(owner.agentId);
                  void start({ environmentId, owner }).finally(() => setPending(null));
                }}
              >
                <SquarePen />
              </SidebarHeaderIconButton>
            </div>
            {needsModel ? (
              <p className="px-2.5 py-1 text-xs leading-relaxed text-sidebar-muted-foreground">
                Add a model in agent.ts to start chatting.
              </p>
            ) : null}
            {!exists ? (
              <p className="px-2.5 py-1 text-xs leading-relaxed text-sidebar-muted-foreground">
                Agent unavailable. Saved conversations are still here.
              </p>
            ) : null}
            {expanded && history.length === 0 && exists && !needsModel ? (
              <p className="px-2.5 py-1 text-xs text-sidebar-muted-foreground">
                No conversations yet
              </p>
            ) : null}
            {expanded &&
              history.map((thread) => (
                <div key={thread.id} className="group/sidebar-row relative ml-3 rounded-md">
                  <Link
                    className="flex h-9 min-w-0 items-center gap-2 rounded-md px-2.5 pr-9 text-sm text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
                    activeProps={{
                      className: "bg-sidebar-row-active font-medium",
                      "aria-current": "page",
                    }}
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: thread.id }}
                    onClick={(event) => {
                      if (isMobile) setOpenMobile(false);
                      if (thread.archivedAt !== null) {
                        event.preventDefault();
                        void restoreThread({ environmentId, input: { threadId: thread.id } }).then(
                          (result) => {
                            if (result._tag === "Success")
                              void router.navigate({
                                to: "/$environmentId/$threadId",
                                params: { environmentId, threadId: thread.id },
                              });
                            archive.refresh();
                          },
                        );
                      }
                    }}
                  >
                    {thread.archivedAt !== null ? (
                      <Archive
                        aria-hidden
                        className="size-3.5 shrink-0 text-sidebar-muted-foreground"
                      />
                    ) : null}
                    <span className="truncate">{thread.title}</span>
                  </Link>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="absolute top-1 right-1 text-sidebar-muted-foreground sm:opacity-0 sm:group-hover/sidebar-row:opacity-100 sm:group-focus-within/sidebar-row:opacity-100"
                    aria-label={
                      thread.archivedAt === null ? "Archive conversation" : "Restore conversation"
                    }
                    onClick={() => {
                      const command = thread.archivedAt === null ? archiveThread : restoreThread;
                      void command({ environmentId, input: { threadId: thread.id } }).then(() =>
                        archive.refresh(),
                      );
                    }}
                  >
                    {thread.archivedAt === null ? (
                      <Archive className="size-3.5" />
                    ) : (
                      <ArchiveRestore className="size-3.5" />
                    )}
                  </Button>
                </div>
              ))}
          </div>
        );
      })}
    </section>
  );
}

export default function AgentConversationSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();
  const { environments } = useEnvironments();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <div className="flex items-center gap-1 px-[var(--sidebar-content-inset)] py-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-within:ring-2 focus-within:ring-ring">
          <Search aria-hidden className="size-4 shrink-0" />
          <input
            type="search"
            aria-label="Search agents and conversations"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full min-w-0 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
          />
        </label>
        <SidebarHeaderIconButton
          label={archived ? "Hide archived conversations" : "Show archived conversations"}
          aria-pressed={archived}
          onClick={() => setArchived(!archived)}
        >
          <Archive />
        </SidebarHeaderIconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {environments.map((environment) => (
          <AgentEnvironment
            key={environment.environmentId}
            environment={environment}
            archived={archived}
            query={query.trim().toLowerCase()}
          />
        ))}
      </div>
      <div className="px-[var(--sidebar-content-inset)] pb-2">
        <Link
          className="flex h-9 items-center gap-2 rounded-md px-2.5 text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          to="/agents"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
          activeProps={{ className: "bg-sidebar-row-active text-sidebar-foreground" }}
        >
          <Settings2 aria-hidden className="size-4" />
          Browse agents
        </Link>
      </div>
      <SidebarChromeFooter />
    </>
  );
}

function AgentEnvironment({
  environment,
  archived,
  query,
}: {
  environment: ReturnType<typeof useEnvironments>["environments"][number];
  archived: boolean;
  query: string;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const threads = useThreadShells();
  const archive = useEnvironmentQuery(
    archived
      ? orchestrationEnvironment.archivedShellSnapshot({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const scopes = buildAgentConversationScopes({
    environmentId: environment.environmentId,
    projects,
    threads,
    archivedThreads: archive.data?.threads ?? [],
  });
  return (
    <div key={environment.environmentId}>
      {environment.serverConfig?.agentConversations !== true ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Update {environment.label} to start agent conversations.
        </p>
      ) : null}
      {[...scopes].map(([sourceProjectId, scope]) => (
        <AgentScope
          key={sourceProjectId ?? "global"}
          environmentId={environment.environmentId}
          sourceProjectId={sourceProjectId}
          label={environments.length > 1 ? `${scope.label} · ${environment.label}` : scope.label}
          available={scope.available}
          supported={environment.serverConfig?.agentConversations === true}
          archived={archived}
          query={query}
        />
      ))}
    </div>
  );
}
