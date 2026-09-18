import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ModelSelection } from "./modelSelection.ts";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/** Native harness skill names, never executable Eve capabilities. */
export const AgentSkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9:_-]*$/),
);

/** Frozen, provider-independent input to T3's agent harnesses. */
export const ResolvedAgentDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  skills: Schema.Array(AgentSkillName)
    .check(Schema.isMaxLength(20), Schema.isUnique())
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  instructions: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export type ResolvedAgentDefinition = typeof ResolvedAgentDefinition.Type;

/** Omit projectId to discover agents in the environment's home directory. */
export const AgentDefinitionsListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type AgentDefinitionsListInput = typeof AgentDefinitionsListInput.Type;
export const AgentDefinitionsListResult = Schema.Struct({
  scope: Schema.Literals(["global", "project"]),
  agents: Schema.Array(AgentDefinition),
});
export type AgentDefinitionsListResult = typeof AgentDefinitionsListResult.Type;

export class AgentDefinitionError extends Schema.TaggedError<AgentDefinitionError>()(
  "AgentDefinitionError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
