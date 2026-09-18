import {
  ProjectId,
  ResolvedWorkflowProfile,
  WorkflowConfigError,
  type WorkflowProfileSummary,
  WorkflowProfileDefinition,
  type ResolvedWorkflowProfile as ResolvedWorkflowProfileType,
  type ResolvedWorkflowAgent,
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

import { loadAgentDefinition } from "../agents/AgentDefinitionLoader.ts";
import { discoverAgentDefinitions } from "../agents/AgentDefinitionService.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

export { WorkflowConfigError } from "@t3tools/contracts";

export interface WorkflowConfigServiceShape {
  readonly listProfiles: (input: {
    readonly projectId: ProjectId;
  }) => Effect.Effect<ReadonlyArray<WorkflowProfileSummary>, WorkflowConfigError>;
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
const decodeWorkflowProfileDefinition = Schema.decodeUnknownEffect(WorkflowProfileDefinition);
const decodeResolvedWorkflowProfile = Schema.decodeUnknownEffect(ResolvedWorkflowProfile);
const isWorkflowConfigError = Schema.is(WorkflowConfigError);

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

  const resolveRoots = Effect.fn("WorkflowConfigService.resolveRoots")(function* (input: {
    readonly projectId: ProjectId;
    readonly profileId: string;
  }) {
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
    return { globalRoot, repositoryRoot, workspaceRoot: project.workspaceRoot };
  });

  const readProfiles = Effect.fn("WorkflowConfigService.readProfiles")(function* (input: {
    readonly globalRoot: string;
    readonly repositoryRoot: string;
    readonly profileId: string;
  }) {
    const profiles = new Map<string, WorkflowProfileDefinitionType>();
    for (const root of [input.globalRoot, input.repositoryRoot]) {
      const definitions = yield* readDefinitions({
        directory: path.join(root, "profiles"),
        decode: decodeWorkflowProfileDefinition,
        profileId: input.profileId,
      });
      for (const profile of definitions) profiles.set(profile.id, profile);
    }
    return profiles;
  });

  const readAgents = Effect.fn("WorkflowConfigService.readAgents")(function* (input: {
    readonly workspaceRoot: string;
    readonly profileId: string;
  }) {
    const workspaceRoot = yield* fs.realPath(input.workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowConfigError({
            profileId: input.profileId,
            path: input.workspaceRoot,
            detail: "could not resolve the project workspace",
            cause,
          }),
      ),
    );
    const discovered = yield* discoverAgentDefinitions(input.workspaceRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new WorkflowConfigError({
            profileId: input.profileId,
            path: path.join(input.workspaceRoot, ".t3"),
            detail: "could not discover Eve-style agent folders",
            cause,
          }),
      ),
    );
    const byName = new Map<string, Array<(typeof discovered)[number]>>();
    for (const definition of discovered) {
      const definitions = byName.get(definition.name) ?? [];
      definitions.push(definition);
      byName.set(definition.name, definitions);
    }
    return {
      workspaceRoot,
      byId: new Map(discovered.map((definition) => [definition.id, definition])),
      byName,
    };
  });

  const listProfiles: WorkflowConfigServiceShape["listProfiles"] = Effect.fn(
    "WorkflowConfigService.listProfiles",
  )(function* (input) {
    const roots = yield* resolveRoots({ ...input, profileId: "*" });
    const profiles = yield* readProfiles({ ...roots, profileId: "*" });
    return [...profiles.values()]
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  });

  const resolveProfile: WorkflowConfigServiceShape["resolveProfile"] = Effect.fn(
    "WorkflowConfigService.resolveProfile",
  )(function* (input) {
    const roots = yield* resolveRoots(input);
    const profiles = yield* readProfiles({ ...roots, profileId: input.profileId });
    const profile = profiles.get(input.profileId);
    if (profile === undefined) {
      return yield* new WorkflowConfigError({
        profileId: input.profileId,
        detail: `no workflow profile with id ${input.profileId} was found`,
      });
    }
    const agents = yield* readAgents({
      workspaceRoot: roots.workspaceRoot,
      profileId: input.profileId,
    });

    const resolveAgent = (agentId: string, stage: "planner" | "implementer" | "reviewer") => {
      const exact = agents.byId.get(agentId);
      const named = agents.byName.get(agentId) ?? [];
      if (exact === undefined && named.length > 1) {
        return Effect.fail(
          new WorkflowConfigError({
            profileId: input.profileId,
            detail: `agent name ${agentId} is ambiguous; use its .t3-relative catalog id`,
          }),
        );
      }
      const definition = exact ?? named[0];
      if (definition === undefined) {
        return Effect.fail(
          new WorkflowConfigError({
            profileId: input.profileId,
            detail: `agent ${agentId} was not found in the project's Eve-style .t3 agent folders`,
          }),
        );
      }
      return Effect.gen(function* () {
        const agent = yield* loadAgentDefinition(agents.workspaceRoot, definition).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new WorkflowConfigError({
                profileId: input.profileId,
                path: cause.path ?? definition.directory,
                detail: cause.message,
                cause,
              }),
          ),
        );
        const { skills } = agent;
        if (stage !== "reviewer" && skills.length > 0) {
          return yield* new WorkflowConfigError({
            profileId: input.profileId,
            detail: `agent ${agentId} cannot assign skills because only reviewers support skill allowlists`,
          });
        }
        return agent satisfies ResolvedWorkflowAgent;
      }).pipe(
        Effect.mapError((cause) =>
          isWorkflowConfigError(cause)
            ? cause
            : new WorkflowConfigError({
                profileId: input.profileId,
                path: definition.directory,
                detail: `could not read agent ${agentId}`,
                cause,
              }),
        ),
      );
    };

    const planner = yield* resolveAgent(profile.planner, "planner");
    const implementer = yield* resolveAgent(profile.implementer, "implementer");
    const reviewers = yield* Effect.forEach(profile.reviewers, (id) =>
      resolveAgent(id, "reviewer"),
    );
    if (new Set(reviewers.map((reviewer) => reviewer.id)).size !== reviewers.length) {
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
    return { profile: resolvedProfile, workspaceRoot: roots.workspaceRoot };
  });

  return WorkflowConfigService.of({ resolveProfile, listProfiles });
});

export const layer = Layer.effect(WorkflowConfigService, make);
