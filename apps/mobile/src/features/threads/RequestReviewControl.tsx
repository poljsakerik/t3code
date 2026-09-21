import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import {
  CommandId,
  reviewableRun,
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
    projectEnvironment.agentDefinitions({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const dispatch = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!busyRef.current) props.onClose();
  };
  const start = async () => {
    if (busyRef.current || !props.runId || selected.length === 0) return;
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
        agentIds: selected,
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
          ) : catalog.data.agents.length === 0 ? (
            <AppText>
              No agents are configured for this project. Add project agents in the web or desktop
              app, then return here.
            </AppText>
          ) : (
            catalog.data.agents.map((agent) => {
              const checked = selected.includes(agent.id);
              return (
                <Pressable
                  key={agent.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  disabled={busy || (!checked && selected.length >= 20)}
                  className="min-h-12 rounded-xl bg-subtle p-3"
                  onPress={() =>
                    setSelected((current) =>
                      checked ? current.filter((id) => id !== agent.id) : [...current, agent.id],
                    )
                  }
                >
                  <AppText>
                    {checked ? "✓ " : ""}
                    {agent.name}
                  </AppText>
                  <AppText className="text-xs text-foreground-secondary">{agent.directory}</AppText>
                </Pressable>
              );
            })
          )}
          {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy || !props.runId || selected.length === 0 || catalog.isPending}
            className="min-h-12 items-center justify-center rounded-xl bg-subtle disabled:opacity-50"
            onPress={() => void start()}
          >
            <AppText>{busy ? "Starting reviews…" : `Start reviews (${selected.length})`}</AppText>
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
