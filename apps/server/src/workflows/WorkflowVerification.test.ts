import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationV2TurnItem,
  ThreadWorkflowState,
  WorkflowReviewResult,
} from "@t3tools/contracts";
import { MessageId, PlanId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  verificationStateOfWorkflow,
  workflowCandidateMessageOfRun,
  workflowReviewerExecution,
} from "./WorkflowVerification.ts";

const timestamp = "2026-08-26T12:00:00.000Z";
const workflow: ThreadWorkflowState = {
  profileId: "default",
  workspaceRoot: "/workspace",
  status: "checking",
  revision: 2,
  revisionCycles: 1,
  consecutiveFailureCount: 0,
  lastFailureFingerprint: null,
  approvedPlanId: PlanId.make("plan-1"),
  candidateRunId: RunId.make("run-2"),
  workspaceDigest: "digest",
  checks: [],
  reviews: [],
  terminalReason: null,
  updatedAt: timestamp,
};

describe("verified workflow projection", () => {
  it("keeps rejected evidence attached to the revision that produced it", () => {
    const state = verificationStateOfWorkflow({
      ...workflow,
      status: "revising",
      revision: 3,
      checks: [
        {
          checkId: "test",
          name: "Tests",
          command: "vp test",
          revision: 2,
          passed: false,
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "failed",
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
    });

    expect(state).toEqual({
      revision: 2,
      phase: "changes_requested",
      terminal: true,
      itemStatus: "completed",
    });
  });

  it("projects live, approved, and human-required phases without inventing planning cards", () => {
    expect(verificationStateOfWorkflow(workflow)?.phase).toBe("checking");
    expect(verificationStateOfWorkflow({ ...workflow, status: "reviewing" })?.phase).toBe(
      "reviewing",
    );
    expect(verificationStateOfWorkflow({ ...workflow, status: "done" })).toMatchObject({
      phase: "approved",
      itemStatus: "completed",
    });
    expect(
      verificationStateOfWorkflow({
        ...workflow,
        status: "needs_human",
        terminalReason: "Reviewer failed.",
        reviews: [review("failed", null, "Invalid response")],
      }),
    ).toMatchObject({ phase: "needs_human", itemStatus: "failed" });
    expect(verificationStateOfWorkflow({ ...workflow, status: "planning" })).toBeNull();
  });

  it("separates reviewer execution status from its review verdict", () => {
    const rejected = workflowReviewerExecution(
      review("completed", "request_changes", null, "Changes are required."),
    );
    const failed = workflowReviewerExecution(review("failed", null, "Invalid JSON"));

    expect(rejected).toEqual({ status: "completed", result: "Changes are required." });
    expect(failed).toEqual({ status: "failed", result: "Invalid JSON" });
  });

  it("selects the final candidate response from the implementation run", () => {
    const runId = RunId.make("run-candidate");
    const earlier = candidateMessage(runId, 10, "First response");
    const final = candidateMessage(runId, 12, "Final response");
    const anotherRun = candidateMessage(RunId.make("run-other"), 20, "Other response");

    expect(workflowCandidateMessageOfRun([final, anotherRun, earlier], runId)).toBe(final);
  });
});

function candidateMessage(
  runId: RunId,
  ordinal: number,
  text: string,
): Extract<OrchestrationV2TurnItem, { readonly type: "workflow_candidate_message" }> {
  const now = DateTime.makeUnsafe(timestamp);
  return {
    id: TurnItemId.make(`candidate-${ordinal}`),
    threadId: ThreadId.make("thread-candidate"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "workflow_candidate_message",
    messageId: MessageId.make(`candidate-message-${ordinal}`),
    text,
    streaming: false,
  };
}

function review(
  status: WorkflowReviewResult["status"],
  verdict: "approve" | "request_changes" | null,
  error: string | null,
  summary = "Review completed.",
): WorkflowReviewResult {
  return {
    reviewerId: "correctness",
    reviewerThreadId: ThreadId.make("review-correctness"),
    revision: 2,
    status,
    review: verdict === null ? null : { verdict, summary, findings: [] },
    error,
  };
}
