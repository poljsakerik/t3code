import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** Authored agent folders are reusable definitions, independent of running subagent sessions. */
export const AgentDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  directory: TrimmedNonEmptyString,
  parentId: Schema.NullOr(TrimmedNonEmptyString),
  configurationPath: Schema.NullOr(TrimmedNonEmptyString),
  instructionPaths: Schema.Array(TrimmedNonEmptyString),
  slots: Schema.Array(TrimmedNonEmptyString),
});
export type AgentDefinition = typeof AgentDefinition.Type;

export const AgentDefinitionsListInput = Schema.Struct({ projectId: ProjectId });
export type AgentDefinitionsListInput = typeof AgentDefinitionsListInput.Type;
export const AgentDefinitionsListResult = Schema.Array(AgentDefinition);

/** T3 configuration uses provider instance IDs; it does not evaluate Eve modules. */
export const AgentDefinitionConfig = Schema.Struct({
  version: Schema.Literal(1),
  name: TrimmedNonEmptyString,
  description: Schema.String.check(Schema.isMaxLength(2_000)),
  modelSelection: Schema.optional(ModelSelection),
});
export type AgentDefinitionConfig = typeof AgentDefinitionConfig.Type;

export const AgentDefinitionGetInput = Schema.Struct({
  projectId: ProjectId,
  id: TrimmedNonEmptyString,
});
export type AgentDefinitionGetInput = typeof AgentDefinitionGetInput.Type;

export const AgentDefinitionDocument = Schema.Struct({
  definition: AgentDefinition,
  config: AgentDefinitionConfig,
  instructions: Schema.String.check(Schema.isMaxLength(64_000)),
  revision: TrimmedNonEmptyString,
});
export type AgentDefinitionDocument = typeof AgentDefinitionDocument.Type;

export const AgentDefinitionSaveInput = Schema.Struct({
  projectId: ProjectId,
  // Creation chooses a slug and optional parent; updates retain their directory identity.
  target: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("create"),
      slug: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/)),
      parentId: Schema.NullOr(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      type: Schema.Literal("update"),
      id: TrimmedNonEmptyString,
      expectedRevision: TrimmedNonEmptyString,
    }),
  ]),
  config: AgentDefinitionConfig,
  instructions: Schema.String.check(Schema.isMaxLength(64_000)),
});
export type AgentDefinitionSaveInput = typeof AgentDefinitionSaveInput.Type;

export const AgentDefinitionDeleteInput = Schema.Struct({
  ...AgentDefinitionGetInput.fields,
  expectedRevision: TrimmedNonEmptyString,
});
export type AgentDefinitionDeleteInput = typeof AgentDefinitionDeleteInput.Type;

export const AgentDefinitionSnapshot = Schema.Struct({
  id: TrimmedNonEmptyString,
  parentId: Schema.NullOr(TrimmedNonEmptyString),
  config: AgentDefinitionConfig,
  instructions: Schema.String,
  skillPaths: Schema.Array(TrimmedNonEmptyString),
});
export type AgentDefinitionSnapshot = typeof AgentDefinitionSnapshot.Type;

export const ThreadAgentDefinition = Schema.Struct({
  definition: AgentDefinitionSnapshot,
  descendants: Schema.Array(AgentDefinitionSnapshot),
});
export type ThreadAgentDefinition = typeof ThreadAgentDefinition.Type;

/** A named delegation can select only an immediate child, with its own subtree. */
export function selectChildAgentDefinition(
  agent: ThreadAgentDefinition | null | undefined,
  id: string,
): ThreadAgentDefinition | undefined {
  const definition = agent?.descendants.find(
    (child) => child.id === id && child.parentId === agent.definition.id,
  );
  if (!agent || !definition) return undefined;
  return {
    definition,
    descendants: agent.descendants.filter((child) =>
      child.id.startsWith(`${definition.id}/subagents/`),
    ),
  };
}

export class AgentDefinitionError extends Schema.TaggedError<AgentDefinitionError>()(
  "AgentDefinitionError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
