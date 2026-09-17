import type { ThreadAgentDefinition } from "@t3tools/contracts";

/** Apply the frozen definition at the provider boundary, keeping user messages unchanged. */
export function withAgentDefinitionContext(
  agent: ThreadAgentDefinition | null | undefined,
  text: string,
): string {
  if (!agent) return text;
  const { definition } = agent;
  const children = agent.descendants.filter((child) => child.parentId === definition.id);
  return [
    "<t3_agent_definition>",
    `Agent: ${definition.config.name}`,
    definition.config.description,
    definition.instructions,
    ...(definition.skillPaths.length === 0
      ? []
      : [
          "This agent has these Markdown skills, relative to the project checkout. Read the relevant skill before using it:",
          ...definition.skillPaths.map((file) => JSON.stringify(file)),
        ]),
    ...(children.length === 0
      ? []
      : [
          "Declared subagents (each has its own instructions and descendants):",
          ...children.map((child) =>
            JSON.stringify({
              agentDefinitionId: child.id,
              name: child.config.name,
              description: child.config.description,
            }),
          ),
          "For these named agents, use T3's delegate_task with agentDefinitionId and a self-contained task. Omit target to use the child's configured model, or inherit this thread's model if none is configured. Do not substitute native subagent tools: T3 loads the selected definition. Track the returned taskId with task_status or task_cancel.",
        ]),
    "</t3_agent_definition>",
    "",
    text,
  ]
    .filter((part) => part !== undefined)
    .join("\n");
}
