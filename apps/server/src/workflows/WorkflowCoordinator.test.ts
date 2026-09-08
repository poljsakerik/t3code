import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShellSnapshot,
  ThreadWorkflowState,
  WorkflowCheckResult,
  WorkflowReviewResult,
} from "@t3tools/contracts";
import { PlanId, RunId, ThreadId, WorkflowReview } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProcessRunner } from "../processRunner.ts";
import { allWorkflowReviewsApprove, evaluateWorkflowFailure, live } from "./WorkflowCoordinator.ts";

const encodeReview = Schema.encodeEffect(Schema.fromJsonString(WorkflowReview));

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

for (const completedAtStartup of [false, true]) {
  for (const verdict of ["approve", "request_changes"] as const) {
    it.effect(
      `collects ${completedAtStartup ? "already completed" : "running"} reviewer completions and advances to ${verdict === "approve" ? "done" : "revising"}`,
      () =>
        Effect.gen(function* () {
          const parentId = ThreadId.make("workflow-parent");
          const reviewerIds = workflow.profile!.reviewers.map((reviewer) =>
            ThreadId.make(`workflow-review:${parentId}:1:${reviewer.id}`),
          );
          const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
          const reads = yield* Queue.unbounded<ThreadId>();
          const commands = yield* Queue.unbounded<OrchestrationV2Command>();
          const starts = yield* Queue.unbounded<ThreadId>();
          let current: ThreadWorkflowState = {
            ...workflow,
            status: "reviewing",
            workspaceDigest: NodeCrypto.createHash("sha256").update("\n--status--\n").digest("hex"),
            reviews: reviewerIds.map((reviewerThreadId, index) => ({
              reviewerId: workflow.profile!.reviewers[index]!.id,
              reviewerThreadId,
              revision: 1,
              status: "running",
              review: null,
              error: null,
            })),
          };
          const completed = new Set<ThreadId>(completedAtStartup ? reviewerIds : []);
          const threads = Layer.mock(ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [{ id: parentId, workflow: current }],
                archivedThreads: [],
              } as unknown as OrchestrationV2ThreadShellSnapshot),
            getThreadProjection: (id) =>
              Effect.gen(function* () {
                const projection =
                  id === parentId
                    ? {
                        thread: { id, workflow: current },
                        plans: [
                          {
                            id: current.approvedPlanId,
                            kind: "proposed_plan",
                            markdown: "Approved plan",
                          },
                        ],
                      }
                    : {
                        thread: {
                          id,
                          lineage: {
                            parentThreadId: parentId,
                            relationshipToParent: "subagent",
                          },
                        },
                        runs: [
                          {
                            id: RunId.make(`run-${id}`),
                            status: completed.has(id) ? "completed" : "running",
                          },
                        ],
                        messages: [
                          {
                            runId: RunId.make(`run-${id}`),
                            role: "assistant",
                            text: yield* encodeReview({
                              verdict: id === reviewerIds[0] ? "approve" : verdict,
                              summary: "Review finished",
                              findings:
                                verdict === "request_changes" && id === reviewerIds[1]
                                  ? [
                                      {
                                        id: "bug",
                                        severity: "blocking",
                                        title: "Fix bug",
                                        description: "Repair the regression",
                                      },
                                    ]
                                  : [],
                            }).pipe(Effect.orDie),
                          },
                        ],
                      };
                if (id !== parentId) yield* Queue.offer(reads, id);
                return projection as unknown as OrchestrationV2ThreadProjection;
              }),
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type === "thread.create")
                  return yield* Effect.die("Reviewers must not create top-level threads");
                if (command.type === "workflow.update") {
                  current = command.workflow;
                  yield* Queue.offer(commands, command);
                } else if (command.type === "message.dispatch" && command.threadId !== parentId) {
                  assert.deepEqual(command.workflowSkillAllowlist, []);
                  yield* Queue.offer(starts, command.threadId);
                } else {
                  yield* Queue.offer(commands, command);
                }
                return { sequence: 1, storedEvents: [] };
              }),
            streamDomainEvents: Stream.fromQueue(events),
          });
          const processes = Layer.mock(ProcessRunner)({
            run: () =>
              Effect.succeed({
                stdout: "",
                stderr: "",
                code: null,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          });

          yield* Effect.gen(function* () {
            // Resume the idempotent reviewer turns from persisted subagent state.
            yield* Queue.take(starts);
            yield* Queue.take(starts);
            for (let index = 0; index < 2; index++) yield* Queue.take(reads);
            if (!completedAtStartup) {
              completed.add(reviewerIds[0]!);
              yield* Queue.offer(events, {
                type: "run.updated",
                threadId: reviewerIds[0]!,
              } as OrchestrationV2DomainEvent);
              const progress = yield* Queue.take(commands);
              assert.equal(progress.type, "workflow.update");
              assert.equal(current.status, "reviewing");
              assert.deepEqual(
                current.reviews.map((review) => review.status),
                ["completed", "running"],
              );

              completed.add(reviewerIds[1]!);
              yield* Queue.offer(events, {
                type: "message.updated",
                threadId: reviewerIds[1]!,
              } as OrchestrationV2DomainEvent);
            }
            yield* Queue.take(commands);
            assert.equal(current.status, verdict === "approve" ? "done" : "revising");
            assert.isTrue(current.reviews.every((review) => review.status === "completed"));
            if (verdict === "request_changes") {
              const repair = yield* Queue.take(commands);
              assert.equal(repair.type, "message.dispatch");
              if (repair.type === "message.dispatch")
                assert.include(repair.text, "Repair the regression");
            }
          }).pipe(Effect.provide(live.pipe(Layer.provide(Layer.mergeAll(threads, processes)))));
        }),
    );
  }
}
