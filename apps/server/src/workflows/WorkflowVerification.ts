import type {
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  RunId,
  ThreadWorkflowState,
  WorkflowReviewResult,
} from "@t3tools/contracts";

export interface WorkflowVerificationState {
  readonly revision: number;
  readonly phase: Extract<
    OrchestrationV2TurnItem,
    { readonly type: "workflow_verification" }
  >["phase"];
  readonly itemStatus: OrchestrationV2TurnItem["status"];
  readonly terminal: boolean;
}

export function verificationStateOfWorkflow(
  workflow: ThreadWorkflowState,
): WorkflowVerificationState | null {
  const hasEvidence = workflow.checks.length > 0 || workflow.reviews.length > 0;
  const projectsVerification =
    workflow.status === "checking" ||
    workflow.status === "reviewing" ||
    workflow.status === "done" ||
    ((workflow.status === "revising" || workflow.status === "needs_human") && hasEvidence);
  if (!projectsVerification) return null;

  const revision =
    workflow.reviews[0]?.revision ?? workflow.checks[0]?.revision ?? workflow.revision;
  const phase =
    workflow.status === "checking"
      ? ("checking" as const)
      : workflow.status === "reviewing"
        ? ("reviewing" as const)
        : workflow.status === "done"
          ? ("approved" as const)
          : workflow.status === "needs_human"
            ? ("needs_human" as const)
            : ("changes_requested" as const);
  const terminal = phase === "approved" || phase === "changes_requested" || phase === "needs_human";
  return {
    revision,
    phase,
    terminal,
    itemStatus: phase === "needs_human" ? "failed" : terminal ? "completed" : "running",
  };
}

export function workflowReviewerExecution(review: WorkflowReviewResult): {
  readonly status: OrchestrationV2Subagent["status"];
  readonly result: string | null;
} {
  return {
    status:
      review.status === "running" ? "running" : review.status === "failed" ? "failed" : "completed",
    result: review.review?.summary ?? review.error,
  };
}

export function workflowCandidateMessageOfRun(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: RunId,
): Extract<OrchestrationV2TurnItem, { readonly type: "workflow_candidate_message" }> | undefined {
  return items
    .filter(
      (
        item,
      ): item is Extract<
        OrchestrationV2TurnItem,
        { readonly type: "workflow_candidate_message" }
      > => item.type === "workflow_candidate_message" && item.runId === runId,
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}
