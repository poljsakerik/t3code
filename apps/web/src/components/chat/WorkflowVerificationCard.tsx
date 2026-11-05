import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { CheckIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { use, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { reviewFindingsPrompt } from "./MessagesTimeline.logic";
import { TimelineRowActivityCtx, TimelineRowCtx } from "./timelineRowContext";

/**
 * A verified workflow's deterministic checks and reviewer verdicts for one revision. A requested
 * review ends with the user picking which findings to implement.
 */
export function WorkflowVerificationCard({
  item,
}: {
  item: Extract<OrchestrationV2TurnItem, { readonly type: "workflow_verification" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const phasePresentation =
    item.phase === "approved"
      ? {
          label: item.reviewOnly ? "Approved" : "Verified",
          className: "text-success-foreground",
          dot: "bg-success",
        }
      : item.phase === "changes_requested"
        ? {
            label: "Changes requested",
            className: "text-destructive-foreground",
            dot: "bg-destructive",
          }
        : item.phase === "needs_human"
          ? {
              label: item.reviewOnly ? "Review failed" : "Needs human",
              className: "text-destructive-foreground",
              dot: "bg-destructive",
            }
          : item.phase === "reviewing"
            ? { label: "Reviewing", className: "text-info-foreground", dot: "bg-info" }
            : { label: "Running checks", className: "text-info-foreground", dot: "bg-info" };
  const checkById = new Map(item.checks.map((check) => [check.checkId, check] as const));
  const reviewerNameById = new Map(
    item.reviewerLabels.map((reviewer) => [reviewer.id, reviewer.name] as const),
  );
  const passedChecks = item.checks.filter((check) => check.passed).length;
  const approvedReviews = item.reviews.filter(
    (review) => review.status === "completed" && review.review?.verdict === "approve",
  ).length;
  // Requested reviews end with the user choosing which findings to act on;
  // verification loops feed their findings back to the implementer themselves.
  const onImplement = ctx.onImplementReviewFindings;
  const { isWorking } = use(TimelineRowActivityCtx);
  const selectableFindings =
    onImplement && item.reviewOnly && !item.reviews.some((review) => review.status === "running")
      ? item.reviews.flatMap((review) =>
          (review.review?.findings ?? []).map((finding) => ({
            key: `${review.reviewerId}:${finding.id}`,
            finding,
          })),
        )
      : [];
  const [selectedFindingKeys, setSelectedFindingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const selectedFindings = selectableFindings.filter(({ key }) => selectedFindingKeys.has(key));
  const allFindingsSelected =
    selectableFindings.length > 0 && selectedFindings.length === selectableFindings.length;
  const toggleFinding = (key: string, checked: boolean) =>
    setSelectedFindingKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <section
      className="rounded-lg border border-border/60 bg-card/30"
      data-v2-item-type={item.type}
      data-workflow-verification-phase={item.phase}
      data-workflow-verification-revision={item.revision}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <ShieldCheckIcon aria-hidden className={cn("size-4", phasePresentation.className)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium">
              {item.reviewOnly ? "Review · round" : "Verification · revision"} {item.revision}
            </span>
            <span
              className={cn("inline-flex items-center gap-1 text-xs", phasePresentation.className)}
            >
              <span aria-hidden className={cn("size-1.5 rounded-full", phasePresentation.dot)} />
              {phasePresentation.label}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{item.profileName}</p>
        </div>
        <span className="shrink-0 font-mono text-3xs text-muted-foreground">
          {!item.reviewOnly && `${passedChecks}/${item.configuredChecks.length} checks · `}
          {approvedReviews}/{item.reviewerLabels.length} approvals
        </span>
      </div>

      {item.configuredChecks.length > 0 ? (
        <div className="border-b border-border/45 px-3 py-2">
          <p className="mb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Deterministic checks
          </p>
          <div className="space-y-1">
            {item.configuredChecks.map((definition) => {
              const result = checkById.get(definition.id);
              const failed = result !== undefined && !result.passed;
              return (
                <div key={definition.id} className="rounded-md bg-background/45 px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    {result?.passed ? (
                      <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
                    ) : failed ? (
                      <XIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
                    ) : (
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{definition.name}</span>
                    <span className="font-mono text-3xs text-muted-foreground">
                      {result === undefined
                        ? item.phase === "checking"
                          ? "pending"
                          : "not run"
                        : result.passed
                          ? "passed"
                          : result.timedOut
                            ? "timed out"
                            : `exit ${result.exitCode ?? "?"}`}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate ps-5 font-mono text-3xs text-muted-foreground/70">
                    {definition.run}
                  </p>
                  {failed && (result.stdout.trim() || result.stderr.trim()) ? (
                    <details className="mt-1 ps-5 text-3xs">
                      <summary className="cursor-pointer text-destructive-foreground">
                        View failure output
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-muted-foreground">
                        {[result.stdout, result.stderr].filter((text) => text.trim()).join("\n")}
                      </pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {item.reviews.length > 0 ? (
        <div className="px-3 py-2">
          <p className="mb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Reviewers
          </p>
          <div className="space-y-1.5">
            {item.reviews.map((review) => {
              const approved =
                review.status === "completed" && review.review?.verdict === "approve";
              const rejected =
                review.status === "completed" && review.review?.verdict === "request_changes";
              const findings = review.review?.findings ?? [];
              return (
                <div key={review.reviewerId} className="rounded-md bg-background/45 px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    {approved ? (
                      <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
                    ) : rejected || review.status === "failed" ? (
                      <XIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
                    ) : (
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {reviewerNameById.get(review.reviewerId) ?? review.reviewerId}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-3xs",
                        approved
                          ? "text-success-foreground"
                          : rejected || review.status === "failed"
                            ? "text-destructive-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      {approved
                        ? "approved"
                        : rejected
                          ? `${findings.filter((finding) => finding.severity === "blocking").length} blocking`
                          : review.status}
                    </span>
                    <button
                      type="button"
                      className="text-3xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => ctx.onOpenThread(review.reviewerThreadId)}
                    >
                      Open reviewer
                    </button>
                  </div>
                  {review.review?.summary ? (
                    <p className="mt-1 ps-5 text-xs leading-relaxed text-muted-foreground">
                      {review.review.summary}
                    </p>
                  ) : review.error ? (
                    <p className="mt-1 ps-5 text-xs text-destructive-foreground">{review.error}</p>
                  ) : null}
                  {findings.length > 0 ? (
                    <div className="mt-1.5 space-y-1 ps-5">
                      {findings.map((finding) => {
                        const key = `${review.reviewerId}:${finding.id}`;
                        const body = (
                          <div
                            className={cn(
                              "min-w-0 flex-1 border-s ps-2 text-xs",
                              finding.severity === "blocking"
                                ? "border-destructive/60"
                                : "border-border",
                            )}
                          >
                            <div className="flex flex-wrap items-baseline gap-x-1.5">
                              <span className="font-medium">{finding.title}</span>
                              {finding.file ? (
                                <span className="font-mono text-3xs text-muted-foreground">
                                  {finding.file}
                                  {finding.line ? `:${finding.line}` : ""}
                                </span>
                              ) : null}
                            </div>
                            <p className="text-muted-foreground">{finding.description}</p>
                            {finding.evidence ? (
                              <p className="mt-0.5 font-mono text-3xs text-muted-foreground/80">
                                {finding.evidence}
                              </p>
                            ) : null}
                          </div>
                        );
                        return selectableFindings.length > 0 ? (
                          <label key={finding.id} className="flex cursor-pointer items-start gap-2">
                            <Checkbox
                              className="mt-0.5"
                              checked={selectedFindingKeys.has(key)}
                              onCheckedChange={(checked) => toggleFinding(key, checked)}
                            />
                            {body}
                          </label>
                        ) : (
                          <div key={finding.id}>{body}</div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {item.terminalReason ? (
        <p className="border-t border-border/45 px-3 py-2 text-xs text-destructive-foreground">
          {item.terminalReason}
        </p>
      ) : null}

      {onImplement && selectableFindings.length > 0 ? (
        <div className="flex items-center gap-2 border-t border-border/45 px-3 py-2">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={allFindingsSelected}
              indeterminate={selectedFindings.length > 0 && !allFindingsSelected}
              onCheckedChange={() =>
                setSelectedFindingKeys(
                  allFindingsSelected
                    ? new Set()
                    : new Set(selectableFindings.map(({ key }) => key)),
                )
              }
            />
            Select all
            <span className="text-muted-foreground">
              {selectedFindings.length}/{selectableFindings.length} selected
            </span>
          </label>
          <Button
            size="xs"
            disabled={selectedFindings.length === 0 || isWorking}
            onClick={() => {
              onImplement(reviewFindingsPrompt(selectedFindings.map(({ finding }) => finding)));
              setSelectedFindingKeys(new Set());
            }}
          >
            Implement selected
          </Button>
        </div>
      ) : null}
    </section>
  );
}
