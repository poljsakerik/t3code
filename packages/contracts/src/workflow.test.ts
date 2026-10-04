import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ResolvedWorkflowAgent } from "./workflow.ts";

const decodeWorkflowAgent = Schema.decodeUnknownSync(ResolvedWorkflowAgent);

describe("resolved workflow agents", () => {
  it("defaults omitted reviewer skills to an empty allowlist", () => {
    const agent = decodeWorkflowAgent({
      id: "reviewer",
      name: "Reviewer",
      instructions: "Review the implementation.",
    });

    expect(agent.skills).toEqual([]);
  });

  it("decodes reviewer skill assignments", () => {
    const agent = decodeWorkflowAgent({
      id: "reviewer",
      name: "Reviewer",
      skills: ["code-review", "vendor:security"],
      instructions: "Review the implementation.",
    });

    expect(agent.skills).toEqual(["code-review", "vendor:security"]);
  });

  it("rejects invalid or duplicate skill names", () => {
    expect(() =>
      decodeWorkflowAgent({
        id: "reviewer",
        name: "Reviewer",
        skills: ["not a token"],
        instructions: "Review the implementation.",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkflowAgent({
        id: "reviewer",
        name: "Reviewer",
        skills: ["code-review", "code-review"],
        instructions: "Review the implementation.",
      }),
    ).toThrow();
  });
});
