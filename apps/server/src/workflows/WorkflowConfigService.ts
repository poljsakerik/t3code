import {
  ProjectId,
  ResolvedWorkflowProfile,
  WorkflowConfigError,
  WorkflowSkillName,
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
const decodeWorkflowSkillName = Schema.decodeUnknownEffect(WorkflowSkillName);
const isWorkflowConfigError = Schema.is(WorkflowConfigError);
const skillFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

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

  const readAgentInstructions = Effect.fn("WorkflowConfigService.readAgentInstructions")(
    function* (input: {
      readonly directory: string;
      readonly instructionPaths: ReadonlyArray<string>;
      readonly profileId: string;
    }) {
      const parts: Array<string> = [];
      for (const instructionPath of input.instructionPaths) {
        const absolute = path.join(input.directory, path.basename(instructionPath));
        if (instructionPath.toLowerCase().endsWith(".md")) {
          parts.push(
            yield* fs.readFileString(absolute).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkflowConfigError({
                    profileId: input.profileId,
                    path: instructionPath,
                    detail: "could not read agent instructions",
                    cause,
                  }),
              ),
            ),
          );
          continue;
        }
        if (path.basename(instructionPath) !== "instructions") {
          return yield* new WorkflowConfigError({
            profileId: input.profileId,
            path: instructionPath,
            detail:
              "executable agent instructions cannot run in a verified workflow; use Markdown instructions",
          });
        }
        const files = yield* fs.readDirectory(absolute).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowConfigError({
                profileId: input.profileId,
                path: instructionPath,
                detail: "could not read the agent instructions directory",
                cause,
              }),
          ),
        );
        for (const file of files.toSorted()) {
          if (!file.toLowerCase().endsWith(".md")) {
            return yield* new WorkflowConfigError({
              profileId: input.profileId,
              path: path.join(instructionPath, file),
              detail:
                "executable agent instructions cannot run in a verified workflow; use Markdown instructions",
            });
          }
          const filePath = path.join(absolute, file);
          const realPath = yield* fs.realPath(filePath).pipe(Effect.option);
          if (Option.isNone(realPath) || realPath.value !== filePath) {
            return yield* new WorkflowConfigError({
              profileId: input.profileId,
              path: path.join(instructionPath, file),
              detail: "agent instruction paths must not contain symbolic links",
            });
          }
          if ((yield* fs.stat(filePath)).type === "File") {
            parts.push(yield* fs.readFileString(filePath));
          }
        }
      }
      const instructions = parts
        .filter((part) => part.trim().length > 0)
        .join("\n\n")
        .trim();
      if (instructions.length === 0) {
        return yield* new WorkflowConfigError({
          profileId: input.profileId,
          path: input.directory,
          detail: "agent has no Markdown instructions",
        });
      }
      return instructions;
    },
  );

  const readAgentSkills = Effect.fn("WorkflowConfigService.readAgentSkills")(function* (input: {
    readonly directory: string;
    readonly workspaceRoot: string;
    readonly hasSkills: boolean;
    readonly profileId: string;
  }) {
    if (!input.hasSkills) return [];
    const directory = path.join(input.directory, "skills");
    const names = yield* fs.readDirectory(directory).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowConfigError({
            profileId: input.profileId,
            path: directory,
            detail: "could not read agent skills",
            cause,
          }),
      ),
    );
    return yield* Effect.forEach(
      names.toSorted(),
      Effect.fnUntraced(function* (name) {
        const skillDirectory = path.join(directory, name);
        const realDirectory = yield* fs.realPath(skillDirectory).pipe(Effect.option);
        if (Option.isNone(realDirectory) || realDirectory.value !== skillDirectory) {
          return yield* new WorkflowConfigError({
            profileId: input.profileId,
            path: skillDirectory,
            detail: "agent skill entries must not be symbolic links",
          });
        }
        if ((yield* fs.stat(skillDirectory)).type !== "Directory") {
          return yield* new WorkflowConfigError({
            profileId: input.profileId,
            path: skillDirectory,
            detail: "verified workflow skills must be Eve-style directories containing SKILL.md",
          });
        }
        const filePath = path.join(skillDirectory, "SKILL.md");
        const realPath = yield* fs.realPath(filePath).pipe(Effect.option);
        if (Option.isNone(realPath) || realPath.value !== filePath) {
          return yield* new WorkflowConfigError({
            profileId: input.profileId,
            path: filePath,
            detail: "agent skill directories must contain a non-symbolic SKILL.md",
          });
        }
        const contents = yield* fs.readFileString(filePath).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowConfigError({
                profileId: input.profileId,
                path: filePath,
                detail: "could not read agent skill definition",
                cause,
              }),
          ),
        );
        const frontmatter = skillFrontmatter.exec(contents)?.[1];
        const decoded =
          frontmatter === undefined
            ? undefined
            : yield* Effect.try({
                try: () => parse(frontmatter) as unknown,
                catch: () => undefined,
              });
        const declaredName =
          typeof decoded === "object" && decoded !== null
            ? Reflect.get(decoded, "name")
            : undefined;
        const skillName = yield* decodeWorkflowSkillName(declaredName).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowConfigError({
                profileId: input.profileId,
                path: filePath,
                detail: "agent skill SKILL.md must declare a valid frontmatter name",
                cause,
              }),
          ),
        );
        if (skillName !== name) {
          return yield* new WorkflowConfigError({
            profileId: input.profileId,
            path: filePath,
            detail: `agent skill frontmatter name ${skillName} must match its directory ${name}`,
          });
        }
        return {
          name: skillName,
          relativePath: path.relative(input.workspaceRoot, filePath).split(path.sep).join("/"),
        };
      }),
    );
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
        const directory = path.join(agents.workspaceRoot, definition.directory);
        for (const slot of definition.slots) {
          if (["skills", "subagents"].includes(slot)) continue;
          const entries = yield* fs
            .readDirectory(path.join(directory, slot))
            .pipe(
              Effect.catchTag("PlatformError", (error) =>
                error.reason._tag === "NotFound"
                  ? Effect.succeed([] as Array<string>)
                  : Effect.fail(error),
              ),
            );
          if (entries.length > 0) {
            return yield* new WorkflowConfigError({
              profileId: input.profileId,
              path: path.join(definition.directory, slot),
              detail: `agent ${agentId} has an authored ${slot}/ capability, which cannot run through the T3 provider harness`,
            });
          }
        }
        const skills = yield* readAgentSkills({
          directory,
          workspaceRoot: agents.workspaceRoot,
          hasSkills: definition.slots.includes("skills"),
          profileId: input.profileId,
        });
        if (stage !== "reviewer" && skills.length > 0) {
          return yield* new WorkflowConfigError({
            profileId: input.profileId,
            detail: `agent ${agentId} cannot assign skills because only reviewers support skill assignments`,
          });
        }
        return {
          id: agentId,
          name: definition.name,
          skills,
          instructions: yield* readAgentInstructions({
            directory,
            instructionPaths: definition.instructionPaths,
            profileId: input.profileId,
          }),
        } satisfies ResolvedWorkflowAgent;
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
    return { profile: resolvedProfile, workspaceRoot: roots.workspaceRoot };
  });

  return WorkflowConfigService.of({ resolveProfile, listProfiles });
});

export const layer = Layer.effect(WorkflowConfigService, make);
