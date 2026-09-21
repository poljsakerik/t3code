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

/** List the environment's global and project agents, with the current project first. */
export const AgentCatalogInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type AgentCatalogInput = typeof AgentCatalogInput.Type;
export const AgentCatalogResult = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      projectId: Schema.NullOr(ProjectId),
      name: TrimmedNonEmptyString,
      agents: Schema.Array(AgentDefinition),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type AgentCatalogResult = typeof AgentCatalogResult.Type;

/** Plain Markdown sources only; loading the editor never evaluates authored modules. */
export const AgentInstructionDocument = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.NullOr(Schema.String),
});
export type AgentInstructionDocument = typeof AgentInstructionDocument.Type;

export const AgentDefinitionGetInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  agentId: TrimmedNonEmptyString,
});
export type AgentDefinitionGetInput = typeof AgentDefinitionGetInput.Type;

/** Agent folder IDs are local to their source project, or to the environment's home. */
export function agentDefinitionKey(input: AgentDefinitionGetInput): string {
  return JSON.stringify([input.projectId ?? null, input.agentId]);
}
/** A skill package owned by this agent, not installed into a provider's shared catalog. */
export const AgentInstalledSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type AgentInstalledSkill = typeof AgentInstalledSkill.Type;

const SkillPackageName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
);
export const AgentSkillInstallInput = Schema.Struct({
  ...AgentDefinitionGetInput.fields,
  source: TrimmedNonEmptyString.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  ),
  name: SkillPackageName,
});
export type AgentSkillInstallInput = typeof AgentSkillInstallInput.Type;
export const AgentSkillRemoveInput = Schema.Struct({
  ...AgentDefinitionGetInput.fields,
  name: SkillPackageName,
});
export type AgentSkillRemoveInput = typeof AgentSkillRemoveInput.Type;
export const AgentSkillSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMinLength(2), Schema.isMaxLength(100)),
});
export type AgentSkillSearchInput = typeof AgentSkillSearchInput.Type;
export const AgentSkillSearchResult = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: SkillPackageName,
      source: AgentSkillInstallInput.fields.source,
      installs: Schema.Finite,
    }),
  ),
});
export type AgentSkillSearchResult = typeof AgentSkillSearchResult.Type;

export const AgentDefinitionGetResult = Schema.Struct({
  agent: AgentDefinition,
  documents: Schema.Array(AgentInstructionDocument),
  otherInstructionPaths: Schema.Array(TrimmedNonEmptyString),
  installedSkills: Schema.Array(AgentInstalledSkill).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type AgentDefinitionGetResult = typeof AgentDefinitionGetResult.Type;

export const AgentDefinitionCreateInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  parentId: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString.check(
    Schema.isMaxLength(80),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  ),
  instructions: Schema.String.check(Schema.isMaxLength(1_000_000)),
});
export type AgentDefinitionCreateInput = typeof AgentDefinitionCreateInput.Type;

export const AgentDefinitionUpdateInput = Schema.Struct({
  ...AgentDefinitionGetInput.fields,
  path: TrimmedNonEmptyString,
  content: Schema.String.check(Schema.isMaxLength(1_000_000)),
  expectedContent: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_000_000))),
});
export type AgentDefinitionUpdateInput = typeof AgentDefinitionUpdateInput.Type;

export class AgentDefinitionError extends Schema.TaggedError<AgentDefinitionError>()(
  "AgentDefinitionError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
