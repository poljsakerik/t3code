import { assert, it } from "@effect/vitest";
import type {
  ThreadWorkflowState,
  WorkflowCheckResult,
  WorkflowReviewResult,
} from "@t3tools/contracts";
import { PlanId, RunId, ThreadId } from "@t3tools/contracts";

import { allWorkflowReviewsApprove, evaluateWorkflowFailure } from "./WorkflowCoordinator.ts";

const timestamp = "2026-08-25T12:00:00.000Z";
const agent = (id: string, role: "planner" | "implementer" | "reviewer") => ({
  version: 1 as const,
  id,
  name: id,
  role,
  skills: [],
  instructions: `Act as ${role}.`,
});
const workflow: ThreadWorkflowState = {
  profileId: "default",
  workspaceRoot: "/workspace",
  profile: {
    version: 1,
    id: "default",
    name: "Default",
    planner: agent("planner", "planner"),
    implementer: agent("implementer", "implementer"),
    reviewers: [agent("correctness", "reviewer"), agent("maintainability", "reviewer")],
    checks: [{ id: "test", name: "Tests", run: "vp test", timeoutMs: 60_000 }],
    limits: { maxRevisionCycles: 3, identicalFailureLimit: 2 },
  },
  status: "checking",
  revision: 1,
  revisionCycles: 0,
  consecutiveFailureCount: 0,
  lastFailureFingerprint: null,
  approvedPlanId: PlanId.make("plan-1"),
  candidateRunId: RunId.make("run-1"),
  workspaceDigest: "digest",
  checks: [],
  reviews: [],
  terminalReason: null,
  updatedAt: timestamp,
};
const failedCheck: WorkflowCheckResult = {
  checkId: "test",
  name: "Tests",
  command: "vp test",
  revision: 1,
  passed: false,
  exitCode: 1,
  timedOut: false,
  stdout: "",
  stderr: "one test failed",
  startedAt: timestamp,
  completedAt: timestamp,
};

it("requires human input after the same gate failure repeats", () => {
  const first = evaluateWorkflowFailure({ workflow, checks: [failedCheck], reviews: [] });
  assert.equal(first.terminalReason, null);

  const second = evaluateWorkflowFailure({
    workflow: {
      ...workflow,
      revisionCycles: first.cycles,
      consecutiveFailureCount: first.consecutive,
      lastFailureFingerprint: first.fingerprint,
    },
    checks: [failedCheck],
    reviews: [],
  });

  assert.equal(second.consecutive, 2);
  assert.match(second.terminalReason ?? "", /same workflow failure repeated/);
});

it("enforces the configured revision budget", () => {
  const result = evaluateWorkflowFailure({
    workflow: { ...workflow, revisionCycles: 3 },
    checks: [{ ...failedCheck, stderr: "a new failure" }],
    reviews: [],
  });

  assert.match(result.terminalReason ?? "", /Revision budget of 3/);
});

it("requires every configured review result to approve", () => {
  const review = (reviewerId: string, verdict: "approve" | "request_changes") =>
    ({
      reviewerId,
      reviewerThreadId: ThreadId.make(`review-${reviewerId}`),
      revision: 1,
      status: "completed",
      review: { verdict, summary: verdict, findings: [] },
      error: null,
    }) satisfies WorkflowReviewResult;

  assert.isTrue(allWorkflowReviewsApprove([review("a", "approve"), review("b", "approve")]));
  assert.isFalse(
    allWorkflowReviewsApprove([review("a", "approve"), review("b", "request_changes")]),
  );
});
