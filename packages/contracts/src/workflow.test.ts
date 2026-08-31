import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { WorkflowAgentDefinition } from "./workflow.ts";

const decodeWorkflowAgent = Schema.decodeUnknownSync(WorkflowAgentDefinition);

describe("workflow agents", () => {
  it("defaults omitted reviewer skills to an empty allowlist", () => {
    const agent = decodeWorkflowAgent({
      version: 1,
      id: "reviewer",
      name: "Reviewer",
      role: "reviewer",
      instructions: "Review the implementation.",
    });

    expect(agent.skills).toEqual([]);
  });

  it("decodes reviewer skill assignments", () => {
    const agent = decodeWorkflowAgent({
      version: 1,
      id: "reviewer",
      name: "Reviewer",
      role: "reviewer",
      skills: ["code-review", "vendor:security"],
      instructions: "Review the implementation.",
    });

    expect(agent.skills).toEqual(["code-review", "vendor:security"]);
  });

  it("rejects invalid or duplicate skill names", () => {
    expect(() =>
      decodeWorkflowAgent({
        version: 1,
        id: "reviewer",
        name: "Reviewer",
        role: "reviewer",
        skills: ["not a token"],
        instructions: "Review the implementation.",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkflowAgent({
        version: 1,
        id: "reviewer",
        name: "Reviewer",
        role: "reviewer",
        skills: ["code-review", "code-review"],
        instructions: "Review the implementation.",
      }),
    ).toThrow();
  });
});
