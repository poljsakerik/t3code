import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  reviewableRun,
  agentDefinitionKey,
  type AgentDefinitionGetInput,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useRef, useState } from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadProjection } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { projectEnvironment } from "~/state/projects";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const reviewThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(Atom.keepAlive);

export function openRequestReviewDialog(threadRef: ScopedThreadRef) {
  appAtomRegistry.set(reviewThreadAtom, threadRef);
}

export function RequestReviewDialogHost() {
  const threadRef = useAtomValue(reviewThreadAtom);
  return threadRef ? (
    <RequestReviewDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  ) : null;
}

function RequestReviewDialog({ threadRef }: { threadRef: ScopedThreadRef }) {
  const projection = useThreadProjection(threadRef)?.projection;
  const run = projection ? reviewableRun(projection) : null;
  const catalog = useEnvironmentQuery(
    projection && projection.thread.projectId !== null
      ? projectEnvironment.agentCatalog({
          environmentId: threadRef.environmentId,
          input: { projectId: projection.thread.projectId },
        })
      : null,
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
    if (!busyRef.current) appAtomRegistry.set(reviewThreadAtom, null);
  };
  const start = async () => {
    if (busyRef.current || !run || selected.size === 0) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await dispatch({
      environmentId: threadRef.environmentId,
      input: {
        type: "thread.review",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
        runId: run.id,
        agents: [...selected.values()],
        createdBy: "user",
        creationSource: "web",
      },
    });
    busyRef.current = false;
    setBusy(false);
    if (result._tag === "Success") close();
    else setError(formatEnvironmentQueryError(result.cause));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Request a review</DialogTitle>
          <DialogDescription>
            Select agents to review this task in parallel. Each agent reports its findings in the
            conversation and Agents panel.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {!run ? (
            <p role="status" className="text-sm text-muted-foreground">
              Wait for the latest task and its agents to finish before requesting a review.
            </p>
          ) : null}
          {catalog.error ? (
            <div role="alert">
              <p>{catalog.error}</p>
              <Button variant="outline" onClick={catalog.refresh}>
                Try again
              </Button>
            </div>
          ) : !catalog.data ? (
            <p role="status">Loading agents…</p>
          ) : catalog.data.groups.every((group) => group.agents.length === 0 && !group.error) ? (
            <p className="text-sm text-muted-foreground">
              No agents are configured in this environment. Add agents in Agents, then return here
              to request a review.
            </p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {catalog.data.groups.map((group) =>
                group.agents.length > 0 || group.error ? (
                  <section key={group.projectId ?? "global"} className="space-y-2">
                    <p className="text-sm font-medium">{group.name}</p>
                    {group.error ? (
                      <p role="alert" className="text-sm text-destructive-foreground">
                        {group.error}
                      </p>
                    ) : null}
                    {group.agents.map((agent) => {
                      const reference = {
                        ...(group.projectId === null ? {} : { projectId: group.projectId }),
                        agentId: agent.id,
                      };
                      const key = agentDefinitionKey(reference);
                      const checked = selected.has(key);
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-3 rounded-lg border p-3"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={busy || (!checked && selected.size >= 20)}
                            onCheckedChange={(value) =>
                              setSelected((current) => {
                                const next = new Map(current);
                                if (value) next.set(key, reference);
                                else next.delete(key);
                                return next;
                              })
                            }
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">{agent.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {agent.directory}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </section>
                ) : null,
              )}
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || !run || selected.size === 0 || catalog.isPending}
            onClick={() => void start()}
          >
            {busy
              ? "Starting reviews…"
              : `Start review${selected.size > 1 ? "s" : ""}${selected.size ? ` (${selected.size})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
