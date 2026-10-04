import { assert, it } from "@effect/vitest";
import { ThreadId, type WorkflowReviewResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { collectReviewerResult } from "./Reviewer.ts";

const encodeReviewJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const pending: WorkflowReviewResult = {
  reviewerId: "design",
  reviewerThreadId: ThreadId.make("design-review"),
  revision: 1,
  status: "running",
  review: null,
  error: null,
};
const finding = {
  id: "contrast",
  severity: "advisory" as const,
  title: "Low contrast",
  description: "Increase the contrast of the secondary label.",
  file: "src/Label.tsx",
  line: 12,
  evidence: "The label is hard to read on the card background.",
};

it.effect("preserves structured findings and accepts fenced JSON", () =>
  Effect.gen(function* () {
    for (const verdict of ["approve", "request_changes"] as const) {
      const review = {
        verdict,
        summary: "Reviewed the label.",
        findings: [
          {
            ...finding,
            severity: verdict === "approve" ? ("advisory" as const) : ("blocking" as const),
          },
        ],
      };
      const result = yield* collectReviewerResult({
        pending,
        runStatus: "completed",
        text: `\`\`\`json\n${yield* encodeReviewJson(review)}\n\`\`\``,
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.review, review);
      assert.isNull(result.error);
    }
  }),
);

it.effect("rejects file-only responses, malformed findings, and empty responses", () =>
  Effect.gen(function* () {
    for (const text of [
      "Full review written to /tmp/report.md",
      yield* encodeReviewJson({
        verdict: "approve",
        summary: "Fine",
        findings: [{ title: "Missing details" }],
      }),
      undefined,
      " ",
    ]) {
      const result = yield* collectReviewerResult({ pending, runStatus: "completed", text });
      assert.equal(result.status, "failed");
      assert.isNull(result.review);
      assert.isString(result.error);
    }
  }),
);

it.effect("does not accept approval with blocking findings or a failed run", () =>
  Effect.gen(function* () {
    const text = yield* encodeReviewJson({
      verdict: "approve",
      summary: "Fine",
      findings: [{ ...finding, severity: "blocking" }],
    });
    const inconsistent = yield* collectReviewerResult({ pending, runStatus: "completed", text });
    assert.equal(inconsistent.status, "failed");
    assert.include(inconsistent.error!, "blocking findings");
    for (const runStatus of ["failed", "interrupted"]) {
      const result = yield* collectReviewerResult({
        pending,
        runStatus,
        text: yield* encodeReviewJson({
          verdict: "approve",
          summary: "Fine",
          findings: [],
        }),
      });
      assert.equal(result.status, "failed");
      assert.include(result.error!, runStatus);
    }
  }),
);

it.effect("accepts a single fenced review surrounded by commentary without losing findings", () =>
  Effect.gen(function* () {
    const review = {
      verdict: "request_changes" as const,
      summary: "Source review only.",
      findings: [{ ...finding, severity: "blocking" as const }],
    };
    const json = yield* encodeReviewJson(review);
    for (const text of [
      json,
      `I completed the full critique.\n\n\`\`\`json\n${json}\n\`\`\`\n\nNo browser was available.`,
    ]) {
      const result = yield* collectReviewerResult({ pending, runStatus: "completed", text });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.review, review);
    }
  }),
);

it.effect(
  "rejects ambiguous fenced reviews and validates findings inside a prose-wrapped block",
  () =>
    Effect.gen(function* () {
      const json = yield* encodeReviewJson({ verdict: "approve", summary: "Done", findings: [] });
      for (const text of [
        `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``,
        `Review complete.\n\`\`\`json\n{"verdict":"approve","summary":"Done","findings":[{}]}\n\`\`\``,
      ]) {
        const result = yield* collectReviewerResult({ pending, runStatus: "completed", text });
        assert.equal(result.status, "failed");
        assert.isNull(result.review);
      }
    }),
);
