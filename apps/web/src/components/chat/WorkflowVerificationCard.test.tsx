import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TimelineRowActivityCtx, TimelineRowCtx } from "./timelineRowContext";
import { WorkflowVerificationCard } from "./WorkflowVerificationCard";

const MESSAGE_CREATED_AT = "2026-01-01T00:00:00.000Z";

const item = {
  id: "workflow-verification",
  threadId: "thread-1",
  runId: "run-1",
  nodeId: "node-1",
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 2,
  status: "completed",
  title: "Default workflow",
  startedAt: null,
  completedAt: null,
  updatedAt: {},
  type: "workflow_verification",
  profileId: "default",
  profileName: "Default workflow",
  revision: 1,
  phase: "changes_requested",
  configuredChecks: [{ id: "tests", name: "Tests", run: "vp test", timeoutMs: 60_000 }],
  reviewerLabels: [{ id: "quality", name: "Quality reviewer" }],
  checks: [
    {
      checkId: "tests",
      name: "Tests",
      command: "vp test",
      revision: 1,
      passed: true,
      exitCode: 0,
      timedOut: false,
      stdout: "passed",
      stderr: "",
      startedAt: MESSAGE_CREATED_AT,
      completedAt: MESSAGE_CREATED_AT,
    },
  ],
  reviews: [
    {
      reviewerId: "quality",
      reviewerThreadId: "reviewer-thread-1",
      revision: 1,
      status: "completed",
      review: {
        verdict: "request_changes",
        summary: "One blocking issue remains.",
        findings: [
          {
            id: "finding-1",
            severity: "blocking",
            title: "Missing guard",
            description: "Validate the workflow instruction.",
            file: "src/workflow.ts",
            line: 42,
            evidence: "The unchecked value reaches dispatch.",
          },
        ],
      },
      error: null,
    },
  ],
  terminalReason: null,
} as never;

function render(card: React.ReactNode, onImplementReviewFindings?: (prompt: string) => void) {
  return renderToStaticMarkup(
    <TimelineRowCtx value={{ onOpenThread: () => {}, onImplementReviewFindings } as never}>
      <TimelineRowActivityCtx value={{ isWorking: false } as never}>{card}</TimelineRowActivityCtx>
    </TimelineRowCtx>,
  );
}

describe("WorkflowVerificationCard", () => {
  it("renders structured workflow verification evidence and reviewer links", () => {
    const markup = render(<WorkflowVerificationCard item={item} />);
    expect(markup).toContain('data-v2-item-type="workflow_verification"');
    expect(markup).toContain('data-workflow-verification-phase="changes_requested"');
    expect(markup).toContain("1/1 checks · 0/1 approvals");
    expect(markup).toContain("Quality reviewer");
    expect(markup).toContain("Open reviewer");
    expect(markup).toContain("Missing guard");
    expect(markup).toContain("src/workflow.ts");
    expect(markup).not.toContain("Implement selected");
  });

  it("offers the findings of a finished requested review for implementation", () => {
    const markup = render(
      <WorkflowVerificationCard item={{ ...(item as object), reviewOnly: true } as never} />,
      () => {},
    );
    expect(markup).toContain("Review · round");
    expect(markup).toContain("Implement selected");
  });
});
