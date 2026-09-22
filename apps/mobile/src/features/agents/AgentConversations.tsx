import {
  buildAgentConversationData,
  buildAgentConversationScopes,
} from "@t3tools/client-runtime/state/agent-conversations";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import { StackActions, useNavigation } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { CommandId, ThreadId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useNavigationThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { useHomeThreadSelection } from "../home/home-thread-navigation";

export const conversationModeAtom = Atom.make<"code" | "agents">("code").pipe(Atom.keepAlive);
export const conversationSelectionsAtom = Atom.make<{
  code: ScopedThreadRef | null;
  agents: ScopedThreadRef | null;
}>({ code: null, agents: null }).pipe(Atom.keepAlive);
export function rememberConversation(mode: "code" | "agents", thread: ScopedThreadRef) {
  appAtomRegistry.set(conversationSelectionsAtom, {
    ...appAtomRegistry.get(conversationSelectionsAtom),
    [mode]: thread,
  });
}
export function selectConversationMode(mode: "code" | "agents") {
  appAtomRegistry.set(conversationModeAtom, mode);
}
export function AgentModeTabs({ restoreSelection = true }: { restoreSelection?: boolean }) {
  const selectThread = useHomeThreadSelection();
  const mode = useAtomValue(conversationModeAtom);
  return (
    <View
      className="mx-4 my-2 flex-row gap-1 rounded-xl bg-sidebar-search p-1"
      accessibilityRole="tablist"
    >
      {(["code", "agents"] as const).map((value) => (
        <Pressable
          key={value}
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === value }}
          onPress={() => {
            selectConversationMode(value);
            const last = appAtomRegistry.get(conversationSelectionsAtom)[value];
            if (restoreSelection && last)
              selectThread({ environmentId: last.environmentId, id: last.threadId });
          }}
          className={`min-h-10 flex-1 justify-center rounded-lg px-4 py-2 ${mode === value ? "bg-card" : ""}`}
        >
          <Text
            className={`text-center text-sm font-medium ${mode === value ? "text-foreground" : "text-foreground-muted"}`}
          >
            {value === "code" ? "Code" : "Agents"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function AgentScope({
  environmentId,
  sourceProjectId,
  label,
  available,
  supported,
  archived,
}: {
  environmentId: EnvironmentId;
  sourceProjectId: ProjectId | null;
  label: string;
  available: boolean;
  supported: boolean;
  archived: boolean;
}) {
  const threads = useNavigationThreadShells();
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
  const launch = useAtomCommand(
    orchestrationEnvironment.v2.launchThread,
    "start agent conversation",
  );
  const archiveThread = useAtomCommand(threadEnvironment.archive, "archive conversation");
  const restoreThread = useAtomCommand(threadEnvironment.unarchive, "restore conversation");
  const selectHomeThread = useHomeThreadSelection();
  const navigation = useNavigation();
  const selectThread = (thread: {
    environmentId: EnvironmentId;
    id: import("@t3tools/contracts").ThreadId;
  }) => {
    let target = navigation;
    while (target.getParent()) target = target.getParent()!;
    const state = target.getState();
    if (state && state.routes[state.index]?.name === "NewTaskSheet")
      target.dispatch({
        ...StackActions.replace("Thread", {
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
        target: state.key,
      });
    else selectHomeThread(thread);
  };
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selection = useAtomValue(conversationSelectionsAtom).agents;
  const [error, setError] = useState<string | null>(null);
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
    <View className="gap-2 px-4 py-3">
      <Text className="text-xs text-foreground-muted">{label}</Text>
      {error || catalog.error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error ?? catalog.error}
        </Text>
      ) : null}
      {[...owners.values()].map((owner) => {
        const definition = definitions.find((definition) => definition.id === owner.agentId);
        const exists = definition !== undefined;
        const needsModel = definition?.configurationPath === null;
        const expanded = !collapsed.has(owner.agentId);
        const history = conversations
          .filter((thread) => thread.agent?.agentId === owner.agentId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return (
          <View key={owner.agentId} className="pb-3">
            <View className="flex-row items-center gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2"
                onPress={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(owner.agentId)) next.delete(owner.agentId);
                    else next.add(owner.agentId);
                    return next;
                  })
                }
              >
                <SymbolView
                  name="person.crop.circle"
                  size={18}
                  tintColorClassName="accent-foreground-muted"
                />
                <Text
                  numberOfLines={1}
                  className="min-w-0 flex-1 text-sm font-semibold text-foreground"
                >
                  {owner.name}
                </Text>
                <SymbolView
                  name={expanded ? "chevron.down" : "chevron.right"}
                  size={12}
                  tintColorClassName="accent-foreground-muted"
                />
              </Pressable>
              <Pressable
                className="size-11 items-center justify-center"
                accessibilityLabel={`New conversation with ${owner.name}`}
                accessibilityRole="button"
                disabled={!supported || !exists || needsModel || pending}
                accessibilityState={{ disabled: !supported || !exists || needsModel || pending }}
                onPress={() => {
                  setPending(true);
                  setError(null);
                  const threadId = ThreadId.make(uuidv4());
                  void launch({
                    environmentId,
                    input: {
                      commandId: CommandId.make(uuidv4()),
                      threadId,
                      title: `Conversation with ${owner.name}`,
                      agent: { agentId: owner.agentId, sourceProjectId },
                      creationSource: "mobile",
                    },
                  })
                    .then((result) => {
                      if (result._tag === "Success") selectThread({ environmentId, id: threadId });
                      else if (!isAtomCommandInterrupted(result)) {
                        const cause = squashAtomCommandFailure(result);
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Could not start this conversation. Check the agent configuration and connection.",
                        );
                      }
                    })
                    .finally(() => setPending(false));
                }}
              >
                <SymbolView
                  name="square.and.pencil"
                  size={19}
                  tintColorClassName={
                    !supported || !exists || needsModel || pending
                      ? "accent-foreground-muted"
                      : "accent-foreground"
                  }
                />
              </Pressable>
            </View>
            {needsModel || !exists ? (
              <Text className="pb-2 text-xs text-foreground-muted">
                {needsModel
                  ? "Add a model in agent.ts to start chatting."
                  : "Agent unavailable. Saved conversations are still here."}
              </Text>
            ) : null}
            {expanded && history.length === 0 && exists && !needsModel ? (
              <Text className="py-2 pl-7 text-xs text-foreground-muted">No conversations yet</Text>
            ) : null}
            {expanded &&
              history.map((thread) => (
                <View
                  key={thread.id}
                  className={`ml-5 flex-row items-center rounded-lg px-2 ${selection?.environmentId === environmentId && selection.threadId === thread.id ? "bg-sidebar-search" : ""}`}
                >
                  <Pressable
                    className="min-h-11 min-w-0 flex-1 justify-center py-2"
                    accessibilityRole="button"
                    onPress={() => {
                      if (thread.archivedAt === null)
                        selectThread({ environmentId, id: thread.id });
                      else
                        void restoreThread({ environmentId, input: { threadId: thread.id } }).then(
                          (result) => {
                            if (result._tag === "Success")
                              selectThread({ environmentId, id: thread.id });
                            archive.refresh();
                          },
                        );
                    }}
                  >
                    <Text numberOfLines={1} className="text-sm text-foreground">
                      {thread.title}
                    </Text>
                  </Pressable>
                  <Pressable
                    className="size-11 items-center justify-center"
                    accessibilityLabel={
                      thread.archivedAt === null ? "Archive conversation" : "Restore conversation"
                    }
                    accessibilityRole="button"
                    onPress={() => {
                      void (thread.archivedAt === null ? archiveThread : restoreThread)({
                        environmentId,
                        input: { threadId: thread.id },
                      }).then(() => archive.refresh());
                    }}
                  >
                    <SymbolView
                      name={thread.archivedAt === null ? "archivebox" : "arrow.uturn.backward"}
                      size={16}
                      tintColorClassName="accent-foreground-muted"
                    />
                  </Pressable>
                </View>
              ))}
          </View>
        );
      })}
    </View>
  );
}

export function AgentConversations() {
  const { environments } = useEnvironments();
  const [archived, setArchived] = useState(false);
  return (
    <ScrollView className="flex-1 bg-screen" contentInsetAdjustmentBehavior="automatic">
      {environments.map((environment) => (
        <AgentEnvironment
          key={environment.environmentId}
          environment={environment}
          archived={archived}
        />
      ))}
      <Pressable
        className="px-4 py-3"
        accessibilityRole="button"
        onPress={() => setArchived(!archived)}
      >
        <Text className="text-sm text-primary">{archived ? "Hide archived" : "Show archived"}</Text>
      </Pressable>
    </ScrollView>
  );
}

function AgentEnvironment({
  environment,
  archived,
}: {
  environment: ReturnType<typeof useEnvironments>["environments"][number];
  archived: boolean;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const threads = useNavigationThreadShells();
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
    <View key={environment.environmentId}>
      {environment.serverConfig?.agentConversations !== true ? (
        <Text className="px-4 py-2 text-sm text-foreground-muted">
          Update {environment.label} to start agent conversations.
        </Text>
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
        />
      ))}
    </View>
  );
}
