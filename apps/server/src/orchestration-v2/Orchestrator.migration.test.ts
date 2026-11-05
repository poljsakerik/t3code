import { assert, it } from "@effect/vitest";

import { isProposedPlanImplementable, shouldPrepareLegacyImportHandoff } from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it("allows completed plans only through the planned workflow lifecycle", () => {
  assert.isTrue(isProposedPlanImplementable({ planStatus: "active", workflowStatus: null }));
  assert.isTrue(
    isProposedPlanImplementable({ planStatus: "completed", workflowStatus: "planned" }),
  );
  assert.isFalse(isProposedPlanImplementable({ planStatus: "completed", workflowStatus: null }));
  assert.isFalse(
    isProposedPlanImplementable({ planStatus: "completed", workflowStatus: "planning" }),
  );
  assert.isFalse(
    isProposedPlanImplementable({ planStatus: "superseded", workflowStatus: "planned" }),
  );
});
