import { expect, it } from "vite-plus/test";
import { selectChildAgentDefinition, type AgentDefinitionSnapshot } from "@t3tools/contracts";
import { withAgentDefinitionContext } from "./agentDefinitionContext.ts";

const definition = (id: string, parentId: string | null): AgentDefinitionSnapshot => ({
  id,
  parentId,
  config: { version: 1, name: id, description: "Specialist" },
  instructions: `Private instructions for ${id}`,
  skillPaths: [`${id}/skills/task.md`],
});

it("exposes only immediate child descriptions and the active agent's instructions", () => {
  const agent = {
    definition: definition("agent", null),
    descendants: [
      definition("agent/subagents/google", "agent"),
      definition("agent/subagents/google/subagents/gmail", "agent/subagents/google"),
      definition("agent/subagents/reviewer", "agent"),
    ],
  };
  const prompt = withAgentDefinitionContext(agent, "Handle the request");
  expect(prompt).toContain("Private instructions for agent\n");
  expect(prompt).toContain('"agentDefinitionId":"agent/subagents/google"');
  expect(prompt).not.toContain("Private instructions for agent/subagents/google");
  expect(prompt).not.toContain("gmail");
  expect(prompt).toContain("agent/skills/task.md");
  expect(prompt.endsWith("Handle the request")).toBe(true);

  const child = selectChildAgentDefinition(agent, "agent/subagents/google");
  const childPrompt = withAgentDefinitionContext(child, "Child request");
  expect(childPrompt).toContain("Private instructions for agent/subagents/google");
  expect(childPrompt).toContain('"agentDefinitionId":"agent/subagents/google/subagents/gmail"');
  expect(childPrompt).not.toContain("reviewer");
  expect(childPrompt).not.toContain("agent/skills/task.md");
});

it("leaves ordinary provider messages unchanged", () => {
  expect(withAgentDefinitionContext(undefined, "Hello")).toBe("Hello");
  expect(withAgentDefinitionContext(null, "/compact")).toBe("/compact");
});
