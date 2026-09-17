import * as Schema from "effect/Schema";

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
