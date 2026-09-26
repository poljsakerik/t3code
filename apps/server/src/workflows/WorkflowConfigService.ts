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
import * as NodeOS from "node:os";
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
    readonly projectId?: ProjectId | undefined;
  }) => Effect.Effect<ReadonlyArray<WorkflowProfileSummary>, WorkflowConfigError>;
  readonly resolveProfile: (input: {
    readonly projectId: ProjectId;
    readonly profileId: string;
    readonly scope?: "global" | "project";
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
    readonly scope?: "global" | "project";
  }) {
    const profiles = new Map<
      string,
      { definition: WorkflowProfileDefinitionType; scope: "global" | "project" }
    >();
    for (const [root, scope] of [
      [input.globalRoot, "global"],
      [input.repositoryRoot, "project"],
    ] as const) {
      if (input.scope !== undefined && input.scope !== scope) continue;
      const definitions = yield* readDefinitions({
        directory: path.join(root, "profiles"),
        decode: decodeWorkflowProfileDefinition,
        profileId: input.profileId,
      });
      for (const profile of definitions) profiles.set(profile.id, { definition: profile, scope });
    }
    return profiles;
  });

  const readAgents = Effect.fn("WorkflowConfigService.readAgents")(function* (input: {
    readonly workspaceRoot: string;
    readonly profileId: string;
  }) {
    const roots = yield* Effect.forEach([input.workspaceRoot, NodeOS.homedir()], (root) =>
      fs.realPath(root),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowConfigError({
            profileId: input.profileId,
            path: input.workspaceRoot,
            detail: "could not resolve the project or global agent workspace",
            cause,
          }),
      ),
    );
    return yield* Effect.forEach(
      [...new Set(roots)],
      Effect.fnUntraced(function* (workspaceRoot) {
        const definitions = yield* discoverAgentDefinitions(workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowConfigError({
                profileId: input.profileId,
                path: path.join(workspaceRoot, ".t3"),
                detail: "could not discover Eve-style agent folders",
                cause,
              }),
          ),
        );
        return definitions.map((definition) => ({ workspaceRoot, definition }));
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  });

  const listProfiles: WorkflowConfigServiceShape["listProfiles"] = Effect.fn(
    "WorkflowConfigService.listProfiles",
  )(function* (input) {
    const roots =
      input.projectId === undefined
        ? { globalRoot: path.join(config.stateDir, "workflows"), repositoryRoot: null }
        : yield* resolveRoots({ projectId: input.projectId, profileId: "*" });
    const global = yield* readDefinitions({
      directory: path.join(roots.globalRoot, "profiles"),
      decode: decodeWorkflowProfileDefinition,
      profileId: "*",
    });
    const project =
      roots.repositoryRoot === null
        ? []
        : yield* readDefinitions({
            directory: path.join(roots.repositoryRoot, "profiles"),
            decode: decodeWorkflowProfileDefinition,
            profileId: "*",
          });
    const projectById = new Map(project.map((definition) => [definition.id, definition]));
    const globalById = new Map(global.map((definition) => [definition.id, definition]));
    return [
      ...[...projectById.values()].map(({ id, name }) => ({ id, name, scope: "project" as const })),
      ...[...globalById.values()].map(({ id, name }) => ({ id, name, scope: "global" as const })),
    ].sort(
      (a, b) =>
        (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  });

  const resolveProfile: WorkflowConfigServiceShape["resolveProfile"] = Effect.fn(
    "WorkflowConfigService.resolveProfile",
  )(function* (input) {
    const roots = yield* resolveRoots(input);
    const profiles = yield* readProfiles({
      ...roots,
      profileId: input.profileId,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    });
    const profile = profiles.get(input.profileId)?.definition;
    if (profile === undefined) {
      return yield* new WorkflowConfigError({
        profileId: input.profileId,
        detail: `no workflow profile with id ${input.profileId} was found`,
      });
    }
    const [projectAgents = [], globalAgents = []] = yield* readAgents({
      workspaceRoot: roots.workspaceRoot,
      profileId: input.profileId,
    });

    const resolveAgent = (agentId: string, stage: "planner" | "implementer" | "reviewer") => {
      const projectMatches = projectAgents.filter(
        ({ definition }) => definition.id === agentId || definition.name === agentId,
      );
      const matches =
        projectMatches.length > 0
          ? projectMatches
          : globalAgents.filter(
              ({ definition }) => definition.id === agentId || definition.name === agentId,
            );
      if (matches.length > 1) {
        return Effect.fail(
          new WorkflowConfigError({
            profileId: input.profileId,
            detail: `agent reference ${agentId} is ambiguous; found ${matches
              .map(({ workspaceRoot, definition }) =>
                path.join(workspaceRoot, definition.directory),
              )
              .join(", ")}. Give these agents unique names and update the profile reference`,
          }),
        );
      }
      const match = matches[0];
      if (match === undefined) {
        return Effect.fail(
          new WorkflowConfigError({
            profileId: input.profileId,
            detail: `agent ${agentId} was not found in the project or global Eve-style .t3 agent folders`,
          }),
        );
      }
      const { workspaceRoot, definition } = match;
      return Effect.gen(function* () {
        const agent = yield* loadAgentDefinition(workspaceRoot, definition).pipe(
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
