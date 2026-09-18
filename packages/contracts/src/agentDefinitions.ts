import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentSkillName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9:_-]*$/),
);
export type AgentSkillName = typeof AgentSkillName.Type;

/** A skill declared by an authored Eve-style agent folder. */
export const AgentSkill = Schema.Struct({
  name: AgentSkillName,
  relativePath: TrimmedNonEmptyString,
});
export type AgentSkill = typeof AgentSkill.Type;

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

/** Filesystem-backed content loaded from an authored agent before a harness is selected. */
export const ResolvedAgentDefinition = Schema.Struct({
  ...AgentDefinition.fields,
  instructions: TrimmedNonEmptyString,
  skills: Schema.Array(AgentSkill),
});
export type ResolvedAgentDefinition = typeof ResolvedAgentDefinition.Type;

export const AgentDefinitionsListInput = Schema.Struct({ projectId: ProjectId });
export type AgentDefinitionsListInput = typeof AgentDefinitionsListInput.Type;
export const AgentDefinitionsListResult = Schema.Array(AgentDefinition);

export class AgentDefinitionError extends Schema.TaggedError<AgentDefinitionError>()(
  "AgentDefinitionError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
