import {
  ProjectId,
  ResolvedWorkflowProfile,
  WorkflowAgentDefinition,
  WorkflowProfileDefinition,
  type ResolvedWorkflowProfile as ResolvedWorkflowProfileType,
  type WorkflowAgentDefinition as WorkflowAgentDefinitionType,
  type WorkflowProfileDefinition as WorkflowProfileDefinitionType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

export class WorkflowConfigError extends Schema.TaggedErrorClass<WorkflowConfigError>()(
  "WorkflowConfigError",
  {
    profileId: Schema.String,
    path: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workflow profile ${this.profileId} is invalid: ${this.detail}`;
  }
}

export interface WorkflowConfigServiceShape {
  readonly resolveProfile: (input: {
    readonly projectId: ProjectId;
    readonly profileId: string;
  }) => Effect.Effect<
    { readonly profile: ResolvedWorkflowProfileType; readonly workspaceRoot: string },
    WorkflowConfigError
  >;
}

export class WorkflowConfigService extends Context.Service<
  WorkflowConfigService,
  WorkflowConfigServiceShape
>()("t3/workflows/WorkflowConfigService") {}

const configFile = /\.(?:ya?ml|json)$/i;
const defaultRepositoryWorkflowsDirectory = ".t3/workflows";
const decodeWorkflowAgentDefinition = Schema.decodeUnknownEffect(WorkflowAgentDefinition);
const decodeWorkflowProfileDefinition = Schema.decodeUnknownEffect(WorkflowProfileDefinition);
const decodeResolvedWorkflowProfile = Schema.decodeUnknownEffect(ResolvedWorkflowProfile);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const projects = yield* ProjectionProjectRepository;
  const projectFileLoader = yield* T3ProjectFileLoader;
  const workspacePaths = yield* WorkspacePaths;

  const readDefinitions = Effect.fn("WorkflowConfigService.readDefinitions")(function* <A>(input: {
    readonly directory: string;
    readonly decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>;
    readonly profileId: string;
  }) {
    const names = yield* fs
      .readDirectory(input.directory, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    return yield* Effect.forEach(
      names.filter((name) => configFile.test(name)).sort(),
      Effect.fnUntraced(function* (name) {
        const filePath = path.join(input.directory, name);
        const text = yield* fs.readFileString(filePath).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowConfigError({
                profileId: input.profileId,
                path: filePath,
                detail: "could not read configuration file",
                cause,
              }),
          ),
        );
        const decoded = yield* Effect.try({
          try: () => parse(text) as unknown,
          catch: (cause) =>
            new WorkflowConfigError({
              profileId: input.profileId,
              path: filePath,
              detail: "configuration could not be parsed",
              cause,
            }),
        });
        return yield* input.decode(decoded).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowConfigError({
                profileId: input.profileId,
                path: filePath,
                detail: "configuration does not match the workflow schema",
                cause,
              }),
          ),
        );
      }),
    );
  });

  const resolveProfile: WorkflowConfigServiceShape["resolveProfile"] = Effect.fn(
    "WorkflowConfigService.resolveProfile",
  )(function* (input) {
    const project = yield* projects.getById({ projectId: input.projectId }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowConfigError({
            profileId: input.profileId,
            detail: `could not resolve project ${input.projectId}`,
            cause,
          }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new WorkflowConfigError({
                profileId: input.profileId,
                detail: `project ${input.projectId} was not found`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const projectFile = yield* projectFileLoader.load(project.workspaceRoot);
    const workflowsDirectory = Option.match(projectFile, {
      onNone: () => defaultRepositoryWorkflowsDirectory,
      onSome: (file) => file.workflowsDirectory ?? defaultRepositoryWorkflowsDirectory,
    });
    const repositoryRoot = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: project.workspaceRoot,
        relativePath: workflowsDirectory,
      })
      .pipe(
        Effect.map((resolved) => resolved.absolutePath),
        Effect.mapError(
          (cause) =>
            new WorkflowConfigError({
              profileId: input.profileId,
              path: workflowsDirectory,
              detail: "the configured workflows directory must be inside the project root",
              cause,
            }),
        ),
      );
    const globalRoot = path.join(config.stateDir, "workflows");
    const [globalAgents, repositoryAgents, globalProfiles, repositoryProfiles] = yield* Effect.all([
      readDefinitions({
        directory: path.join(globalRoot, "agents"),
        decode: decodeWorkflowAgentDefinition,
        profileId: input.profileId,
      }),
      readDefinitions({
        directory: path.join(repositoryRoot, "agents"),
        decode: decodeWorkflowAgentDefinition,
        profileId: input.profileId,
      }),
      readDefinitions({
        directory: path.join(globalRoot, "profiles"),
        decode: decodeWorkflowProfileDefinition,
        profileId: input.profileId,
      }),
      readDefinitions({
        directory: path.join(repositoryRoot, "profiles"),
        decode: decodeWorkflowProfileDefinition,
        profileId: input.profileId,
      }),
    ]);

    const agents = new Map<string, WorkflowAgentDefinitionType>();
    for (const agent of [...globalAgents, ...repositoryAgents]) agents.set(agent.id, agent);
    const profiles = new Map<string, WorkflowProfileDefinitionType>();
    for (const profile of [...globalProfiles, ...repositoryProfiles])
      profiles.set(profile.id, profile);
    const profile = profiles.get(input.profileId);
    if (profile === undefined) {
      return yield* new WorkflowConfigError({
        profileId: input.profileId,
        detail: `no workflow profile with id ${input.profileId} was found`,
      });
    }

    const resolveAgent = (agentId: string, role: WorkflowAgentDefinitionType["role"]) => {
      const agent = agents.get(agentId);
      if (agent === undefined || agent.role !== role) {
        return Effect.fail(
          new WorkflowConfigError({
            profileId: input.profileId,
            detail:
              agent === undefined
                ? `agent ${agentId} was not found`
                : `agent ${agentId} has role ${agent.role}, expected ${role}`,
          }),
        );
      }
      if ((agent.providerInstanceId === undefined) !== (agent.model === undefined)) {
        return Effect.fail(
          new WorkflowConfigError({
            profileId: input.profileId,
            detail: `agent ${agentId} must set both providerInstanceId and model, or neither`,
          }),
        );
      }
      return Effect.succeed(agent);
    };

    const planner = yield* resolveAgent(profile.planner, "planner");
    const implementer = yield* resolveAgent(profile.implementer, "implementer");
    const reviewers = yield* Effect.forEach(profile.reviewers, (id) =>
      resolveAgent(id, "reviewer"),
    );
    if (new Set(profile.reviewers).size !== profile.reviewers.length) {
      return yield* new WorkflowConfigError({
        profileId: input.profileId,
        detail: "reviewer ids must be unique",
      });
    }
    const duplicateCheck = profile.checks.find(
      (check, index) =>
        profile.checks.findIndex((candidate) => candidate.id === check.id) !== index,
    );
    if (duplicateCheck !== undefined) {
      return yield* new WorkflowConfigError({
        profileId: input.profileId,
        detail: `check id ${duplicateCheck.id} is duplicated`,
      });
    }

    const resolvedProfile = yield* decodeResolvedWorkflowProfile({
      ...profile,
      planner,
      implementer,
      reviewers,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowConfigError({
            profileId: input.profileId,
            detail: "resolved profile is invalid",
            cause,
          }),
      ),
    );
    return { profile: resolvedProfile, workspaceRoot: project.workspaceRoot };
  });

  return WorkflowConfigService.of({ resolveProfile });
});

export const layer = Layer.effect(WorkflowConfigService, make);
