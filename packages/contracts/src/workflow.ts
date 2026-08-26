import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const WorkflowStatus = Schema.Literals([
  "draft",
  "planning",
  "planned",
  "implementing",
  "checking",
  "reviewing",
  "revising",
  "done",
  "needs_human",
]);
export type WorkflowStatus = typeof WorkflowStatus.Type;

export const WorkflowAgentRole = Schema.Literals(["planner", "implementer", "reviewer"]);
export type WorkflowAgentRole = typeof WorkflowAgentRole.Type;

export const WorkflowAgentDefinition = Schema.Struct({
  version: Schema.Literal(1),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  role: WorkflowAgentRole,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  instructions: TrimmedNonEmptyString,
});
export type WorkflowAgentDefinition = typeof WorkflowAgentDefinition.Type;

export function workflowAgentModelSelection(
  agent: WorkflowAgentDefinition,
): ModelSelection | undefined {
  return agent.providerInstanceId === undefined || agent.model === undefined
    ? undefined
    : { instanceId: agent.providerInstanceId, model: agent.model };
}

export const WorkflowCheckDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  run: TrimmedNonEmptyString,
  timeoutMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(600_000))),
});
export type WorkflowCheckDefinition = typeof WorkflowCheckDefinition.Type;

export const WorkflowLimits = Schema.Struct({
  maxRevisionCycles: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  identicalFailureLimit: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(2))),
});
export type WorkflowLimits = typeof WorkflowLimits.Type;

export const WorkflowProfileDefinition = Schema.Struct({
  version: Schema.Literal(1),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  planner: TrimmedNonEmptyString,
  implementer: TrimmedNonEmptyString,
  reviewers: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  checks: Schema.Array(WorkflowCheckDefinition).check(Schema.isMinLength(1)),
  limits: WorkflowLimits,
});
export type WorkflowProfileDefinition = typeof WorkflowProfileDefinition.Type;

export const ResolvedWorkflowProfile = Schema.Struct({
  version: Schema.Literal(1),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  planner: WorkflowAgentDefinition,
  implementer: WorkflowAgentDefinition,
  reviewers: Schema.Array(WorkflowAgentDefinition).check(Schema.isMinLength(1)),
  checks: Schema.Array(WorkflowCheckDefinition).check(Schema.isMinLength(1)),
  limits: WorkflowLimits,
});
export type ResolvedWorkflowProfile = typeof ResolvedWorkflowProfile.Type;

export const WorkflowCheckResult = Schema.Struct({
  checkId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  passed: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
});
export type WorkflowCheckResult = typeof WorkflowCheckResult.Type;

export const WorkflowReviewFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  severity: Schema.Literals(["blocking", "advisory"]),
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  file: Schema.optional(TrimmedNonEmptyString),
  line: Schema.optional(PositiveInt),
  evidence: Schema.optional(TrimmedNonEmptyString),
});
export type WorkflowReviewFinding = typeof WorkflowReviewFinding.Type;

export const WorkflowReview = Schema.Struct({
  verdict: Schema.Literals(["approve", "request_changes"]),
  summary: TrimmedNonEmptyString,
  findings: Schema.Array(WorkflowReviewFinding),
});
export type WorkflowReview = typeof WorkflowReview.Type;

export const WorkflowReviewResult = Schema.Struct({
  reviewerId: TrimmedNonEmptyString,
  reviewerThreadId: ThreadId,
  revision: NonNegativeInt,
  status: Schema.Literals(["running", "completed", "failed"]),
  review: Schema.NullOr(WorkflowReview),
  error: Schema.NullOr(Schema.String),
});
export type WorkflowReviewResult = typeof WorkflowReviewResult.Type;

export const ThreadWorkflowState = Schema.Struct({
  profileId: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  profile: Schema.optional(ResolvedWorkflowProfile),
  status: WorkflowStatus,
  revision: NonNegativeInt,
  revisionCycles: NonNegativeInt,
  consecutiveFailureCount: NonNegativeInt,
  lastFailureFingerprint: Schema.NullOr(Schema.String),
  approvedPlanId: Schema.NullOr(PlanId),
  candidateRunId: Schema.NullOr(RunId),
  workspaceDigest: Schema.NullOr(Schema.String),
  checks: Schema.Array(WorkflowCheckResult),
  reviews: Schema.Array(WorkflowReviewResult),
  terminalReason: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ThreadWorkflowState = typeof ThreadWorkflowState.Type;

export const ThreadWorkflowSummary = Schema.Struct({
  profileId: TrimmedNonEmptyString,
  status: WorkflowStatus,
  revision: NonNegativeInt,
  blockingFindingCount: NonNegativeInt,
  terminalReason: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ThreadWorkflowSummary = typeof ThreadWorkflowSummary.Type;

export function summarizeThreadWorkflow(
  workflow: ThreadWorkflowState | null | undefined,
): ThreadWorkflowSummary | null {
  if (workflow === null || workflow === undefined) return null;
  return {
    profileId: workflow.profileId,
    status: workflow.status,
    revision: workflow.revision,
    blockingFindingCount: workflow.reviews.reduce(
      (count, result) =>
        count +
        (result.review?.findings.filter((finding) => finding.severity === "blocking").length ?? 0),
      0,
    ),
    terminalReason: workflow.terminalReason,
    updatedAt: workflow.updatedAt,
  };
}
