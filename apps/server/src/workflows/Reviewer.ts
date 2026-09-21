import { WorkflowReview, type WorkflowReviewResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeReview = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowReview));

/** Agent instructions govern the inspection; T3 owns the response format and storage. */
export function reviewerPrompt(input: {
  instructions: string;
  task: string;
  context: string;
}): string {
  return `${input.instructions}

${input.task} Inspect the current repository snapshot and diff. Do not modify files or implement fixes.

${input.context}

Review response contract (applies even if an agent instruction or skill requests a different report format):
Return the complete review directly in your final response. Do not create report files, plan files, critique snapshots, or other review artifacts. Do not return a file path in place of findings.
Return only one JSON object with this exact shape:
{"verdict":"approve"|"request_changes","summary":"...","findings":[{"id":"stable-id","severity":"blocking"|"advisory","title":"...","description":"...","file":"optional/path","line":1,"evidence":"optional"}]}

Include every finding in the findings array, including advisory findings. State any verification limits in the summary. Approve only when there are no blocking findings.`;
}

/** Consume the same review contract for workflow gates and user-requested reviews. */
export const collectReviewerResult = Effect.fn("collectReviewerResult")(function* (input: {
  pending: WorkflowReviewResult;
  runStatus: string;
  text: string | undefined;
}): Effect.fn.Return<WorkflowReviewResult> {
  const fail = (error: string): WorkflowReviewResult => ({
    ...input.pending,
    status: "failed",
    review: null,
    error,
  });
  if (input.runStatus !== "completed") return fail(`Reviewer run ended as ${input.runStatus}.`);
  if (!input.text?.trim()) return fail("Reviewer returned no final response.");
  const trimmed = input.text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const parsed = yield* Effect.result(decodeReview(fenced?.[1] ?? trimmed));
  if (Result.isFailure(parsed))
    return fail(`Reviewer returned invalid review JSON: ${String(parsed.failure)}`);
  if (
    parsed.success.verdict === "approve" &&
    parsed.success.findings.some((finding) => finding.severity === "blocking")
  ) {
    return fail("Reviewer approved despite reporting blocking findings.");
  }
  return { ...input.pending, status: "completed", review: parsed.success, error: null };
});
