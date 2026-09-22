import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Switch, View } from "react-native";
import {
  CommandId,
  reviewableRun,
  agentDefinitionKey,
  type AgentDefinitionGetInput,
  type EnvironmentId,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { orchestrationEnvironment } from "../../state/orchestration";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";

export function RequestReviewControl(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const projection = useThreadProjection(props)?.projection;
  const run = projection ? reviewableRun(projection) : null;
  const [open, setOpen] = useState(false);
  return (
    <>
      {run ? (
        <Pressable
          accessibilityRole="button"
          className="min-h-11 items-center justify-center"
          onPress={() => setOpen(true)}
        >
          <AppText className="text-sm text-foreground-secondary">Request review</AppText>
        </Pressable>
      ) : null}
      {open && projection ? (
        <RequestReviewModal
          {...props}
          projectId={projection.thread.projectId}
          runId={run?.id ?? null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function RequestReviewModal(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  runId: RunId | null;
  onClose: () => void;
}) {
  const catalog = useEnvironmentQuery(
    projectEnvironment.agentCatalog({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState<ReadonlyMap<string, AgentDefinitionGetInput>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!busyRef.current) props.onClose();
  };
  const start = async () => {
    if (busyRef.current || !props.runId || selected.size === 0) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await dispatch({
      environmentId: props.environmentId,
      input: {
        type: "thread.review",
        commandId: CommandId.make(uuidv4()),
        threadId: props.threadId,
        runId: props.runId,
        agents: [...selected.values()],
        createdBy: "user",
        creationSource: "mobile",
      },
    });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Success") props.onClose();
    else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not start reviews. Try again.");
    }
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View className="flex-1 items-center justify-center bg-black/40 px-6">
        <ScrollView
          className="max-h-[80%] w-full max-w-md grow-0 rounded-3xl bg-screen"
          contentContainerStyle={{ padding: 24, gap: 16 }}
        >
          <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
            Request a review
          </AppText>
          <AppText className="text-foreground-secondary">
            Select agents to review this task in parallel. Open each reviewer in the conversation to
            read its findings.
          </AppText>
          {!props.runId ? (
            <AppText>Wait for the latest task and its agents to finish.</AppText>
          ) : null}
          {catalog.error ? (
            <>
              <AppText accessibilityRole="alert">{catalog.error}</AppText>
              <Pressable accessibilityRole="button" onPress={catalog.refresh}>
                <AppText>Try again</AppText>
              </Pressable>
            </>
          ) : !catalog.data ? (
            <AppText>Loading agents…</AppText>
          ) : catalog.data.groups.every((group) => group.agents.length === 0 && !group.error) ? (
            <AppText>
              No agents are configured in this environment. Add agents in the web or desktop app,
              then return here.
            </AppText>
          ) : (
            catalog.data.groups.map((group) =>
              group.agents.length > 0 || group.error ? (
                <View key={group.projectId ?? "global"} className="gap-2">
                  <AppText className="font-t3-semibold">{group.name}</AppText>
                  {group.error ? <AppText accessibilityRole="alert">{group.error}</AppText> : null}
                  {group.agents.map((agent) => {
                    const reference = {
                      ...(group.projectId === null ? {} : { projectId: group.projectId }),
                      agentId: agent.id,
                    };
                    const key = agentDefinitionKey(reference);
                    const checked = selected.has(key);
                    return (
                      <View
                        key={key}
                        className="min-h-12 flex-row items-center gap-3 rounded-xl bg-subtle p-3"
                      >
                        <View className="min-w-0 flex-1">
                          <AppText>{agent.name}</AppText>
                          <AppText className="text-xs text-foreground-secondary">
                            {agent.directory}
                          </AppText>
                        </View>
                        <Switch
                          accessibilityLabel={`${agent.name}, ${group.name}`}
                          value={checked}
                          disabled={busy || (!checked && selected.size >= 20)}
                          ios_backgroundColorClassName="accent-switch-inactive-track"
                          trackColorOffClassName="accent-switch-inactive-track"
                          trackColorOnClassName="accent-switch-active-track"
                          onValueChange={(value) =>
                            setSelected((current) => {
                              const next = new Map(current);
                              if (value) next.set(key, reference);
                              else next.delete(key);
                              return next;
                            })
                          }
                        />
                      </View>
                    );
                  })}
                </View>
              ) : null,
            )
          )}
          {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy || !props.runId || selected.size === 0 || catalog.isPending}
            className="min-h-12 items-center justify-center rounded-xl bg-subtle disabled:opacity-50"
            onPress={() => void start()}
          >
            <AppText>{busy ? "Starting reviews…" : `Start reviews (${selected.size})`}</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            className="min-h-11 items-center justify-center"
            onPress={close}
          >
            <AppText>Cancel</AppText>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}
