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
      skills: [
        {
          name: "code-review",
          relativePath: ".t3/agents/reviewer/skills/code-review/SKILL.md",
        },
        {
          name: "vendor:security",
          relativePath: ".t3/agents/reviewer/skills/security/SKILL.md",
        },
      ],
      instructions: "Review the implementation.",
    });

    expect(agent.skills).toEqual([
      {
        name: "code-review",
        relativePath: ".t3/agents/reviewer/skills/code-review/SKILL.md",
      },
      {
        name: "vendor:security",
        relativePath: ".t3/agents/reviewer/skills/security/SKILL.md",
      },
    ]);
  });

  it("rejects invalid or duplicate skill definitions", () => {
    expect(() =>
      decodeWorkflowAgent({
        id: "reviewer",
        name: "Reviewer",
        skills: [
          {
            name: "not a token",
            relativePath: ".t3/agents/reviewer/skills/invalid/SKILL.md",
          },
        ],
        instructions: "Review the implementation.",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkflowAgent({
        id: "reviewer",
        name: "Reviewer",
        skills: [
          {
            name: "code-review",
            relativePath: ".t3/agents/reviewer/skills/code-review/SKILL.md",
          },
          {
            name: "code-review",
            relativePath: ".t3/agents/reviewer/skills/duplicate/SKILL.md",
          },
        ],
        instructions: "Review the implementation.",
      }),
    ).toThrow();
  });
});
