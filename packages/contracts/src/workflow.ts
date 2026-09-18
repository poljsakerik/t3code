import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PlanId,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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

export const WorkflowSkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9:_-]*$/),
);
export type WorkflowSkillName = typeof WorkflowSkillName.Type;

export const WorkflowSkill = Schema.Struct({
  name: WorkflowSkillName,
  relativePath: TrimmedNonEmptyString,
});
export type WorkflowSkill = typeof WorkflowSkill.Type;

/** Frozen runtime snapshot resolved from an Eve-style agent folder. */
export const ResolvedWorkflowAgent = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  skills: Schema.Array(WorkflowSkill)
    .check(
      Schema.isMaxLength(20),
      Schema.makeFilter(
        (skills) => new Set(skills.map((skill) => skill.name)).size === skills.length,
      ),
    )
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  instructions: TrimmedNonEmptyString,
});
export type ResolvedWorkflowAgent = typeof ResolvedWorkflowAgent.Type;

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

export const WorkflowProfileSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type WorkflowProfileSummary = typeof WorkflowProfileSummary.Type;

export const WorkflowListProfilesInput = Schema.Struct({ projectId: ProjectId });
export const WorkflowListProfilesResult = Schema.Array(WorkflowProfileSummary);

export class WorkflowConfigError extends Schema.TaggedError<WorkflowConfigError>()(
  "WorkflowConfigError",
  {
    profileId: Schema.String,
    path: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workflow profile ${this.profileId} is invalid: ${this.detail}`;
  }
}

export const ResolvedWorkflowProfile = Schema.Struct({
  version: Schema.Literal(1),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  planner: ResolvedWorkflowAgent,
  implementer: ResolvedWorkflowAgent,
  reviewers: Schema.Array(ResolvedWorkflowAgent).check(Schema.isMinLength(1)),
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
