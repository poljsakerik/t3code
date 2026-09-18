import {
  AgentDefinitionError,
  AgentSkillName,
  type AgentDefinition,
  type AgentDefinitionsListInput,
  type ResolvedAgentDefinition,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { PlatformError } from "effect/PlatformError";
import { parse } from "yaml";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";

const isAgentDefinitionError = Schema.is(AgentDefinitionError);

import {
  classifyAgentRootEntry,
  isDiscoverableAgentRootEntry,
  matchesSupportedModuleBaseName,
  type DirectoryEntryType,
} from "@t3tools/eve/filesystem";

const entryType = (type: string): DirectoryEntryType =>
  type === "File" ? "file" : type === "Directory" ? "directory" : "other";
const decodeAgentSkillName = Schema.decodeUnknownEffect(AgentSkillName);
const skillFrontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** Reads source locations only. Discovering an agent must never execute its TypeScript. */
export const discoverAgentDefinitions = Effect.fn("discoverAgentDefinitions")(
  function* (workspaceRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectRoot = yield* fs.realPath(workspaceRoot);
    const root = path.join(projectRoot, ".t3");
    if (!(yield* fs.exists(root))) return [];
    if ((yield* fs.realPath(root)) !== root) return [];
    if ((yield* fs.stat(root)).type !== "Directory") return [];
    const definitions: Array<AgentDefinition> = [];
    const entries = Effect.fn("AgentDefinitionService.entries")(function* (directory: string) {
      const names = yield* fs
        .readDirectory(directory)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed([] as Array<string>)
              : Effect.fail(error),
          ),
        );
      return yield* Effect.forEach(
        names.toSorted(),
        Effect.fnUntraced(function* (name) {
          const filePath = path.join(directory, name);
          const realPath = yield* fs
            .realPath(filePath)
            .pipe(
              Effect.catchTag("PlatformError", (error) =>
                error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
              ),
            );
          // Ignore symlinks, including loops and sources outside this project.
          if (realPath !== filePath) return { name, type: "SymbolicLink" as const };
          const info = yield* fs.stat(filePath);
          return { name, type: info.type };
        }),
        { concurrency: 8 },
      );
    });
    const relative = (filePath: string) =>
      path.relative(projectRoot, filePath).split(path.sep).join("/") || ".";
    const scan = Effect.fn("AgentDefinitionService.scan")(function* (
      directory: string,
      name: string,
      parentId: string | null,
    ): Effect.fn.Return<void, PlatformError> {
      const children = yield* entries(directory);
      const files = new Set(
        children.filter((entry) => entry.type === "File").map((entry) => entry.name),
      );
      const directories = new Set(
        children.filter((entry) => entry.type === "Directory").map((entry) => entry.name),
      );
      const instructionPaths = children
        .filter((entry) => {
          const kind = classifyAgentRootEntry(entry.name, entryType(entry.type));
          return (
            kind === "instructions-markdown" ||
            kind === "instructions-module" ||
            kind === "instructions-directory"
          );
        })
        .map((entry) => relative(path.join(directory, entry.name)));
      if (
        !children.some((entry) => isDiscoverableAgentRootEntry(entry.name, entryType(entry.type)))
      )
        return;
      const configuration = [...files].find((file) =>
        matchesSupportedModuleBaseName(file, "agent"),
      );
      const id = relative(directory);
      definitions.push({
        id,
        name,
        directory: id,
        parentId,
        configurationPath: configuration ? relative(path.join(directory, configuration)) : null,
        instructionPaths,
        slots: children
          .filter(
            (entry) =>
              entry.type === "Directory" &&
              classifyAgentRootEntry(entry.name, "directory") !== "unknown" &&
              classifyAgentRootEntry(entry.name, "directory") !== "ignored-directory" &&
              classifyAgentRootEntry(entry.name, "directory") !== "instructions-directory",
          )
          .map((entry) => entry.name),
      });
      if (!directories.has("subagents")) return;
      for (const child of yield* entries(path.join(directory, "subagents"))) {
        if (child.type === "Directory")
          yield* scan(path.join(directory, "subagents", child.name), child.name, id);
      }
    });
    const rootEntries = yield* entries(root);
    // Eve gives a single root agent precedence over workspace members.
    if (rootEntries.some((entry) => entry.name === "agent" && entry.type === "Directory")) {
      yield* scan(path.join(root, "agent"), path.basename(projectRoot), null);
    } else if (
      rootEntries.some((entry) => isDiscoverableAgentRootEntry(entry.name, entryType(entry.type)))
    ) {
      yield* scan(root, path.basename(projectRoot), null);
    } else if (rootEntries.some((entry) => entry.name === "agents" && entry.type === "Directory")) {
      for (const member of yield* entries(path.join(root, "agents"))) {
        if (member.type !== "Directory") continue;
        const memberRoot = path.join(root, "agents", member.name);
        const memberEntries = yield* entries(memberRoot);
        if (memberEntries.some((entry) => entry.name === "package.json")) continue;
        const nested = memberEntries.some(
          (entry) => entry.name === "agent" && entry.type === "Directory",
        );
        yield* scan(nested ? path.join(memberRoot, "agent") : memberRoot, member.name, null);
      }
    }
    return definitions;
  },
  Effect.mapError(
    (cause) =>
      new AgentDefinitionError({ message: "Could not discover agent definitions.", cause }),
  ),
);

/** Loads authored Markdown instructions and Eve skill declarations before provider selection. */
export const resolveAgentDefinitions = Effect.fn("resolveAgentDefinitions")(
  function* (workspaceRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectRoot = yield* fs.realPath(workspaceRoot);
    const definitions = yield* discoverAgentDefinitions(projectRoot);

    const readInstructions = Effect.fn("AgentDefinitionService.readInstructions")(function* (
      definition: AgentDefinition,
    ) {
      const directory = path.join(projectRoot, definition.directory);
      const parts: Array<string> = [];
      for (const instructionPath of definition.instructionPaths) {
        const absolute = path.join(projectRoot, instructionPath);
        if (instructionPath.toLowerCase().endsWith(".md")) {
          parts.push(yield* fs.readFileString(absolute));
          continue;
        }
        if (path.basename(instructionPath) !== "instructions") {
          return yield* new AgentDefinitionError({
            message: "Executable agent instructions are not supported; use Markdown instructions.",
            path: instructionPath,
          });
        }
        for (const file of (yield* fs.readDirectory(absolute)).toSorted()) {
          if (!file.toLowerCase().endsWith(".md")) {
            return yield* new AgentDefinitionError({
              message:
                "Executable agent instructions are not supported; use Markdown instructions.",
              path: path.join(instructionPath, file),
            });
          }
          const filePath = path.join(absolute, file);
          const realPath = yield* fs.realPath(filePath).pipe(Effect.option);
          if (Option.isNone(realPath) || realPath.value !== filePath) {
            return yield* new AgentDefinitionError({
              message: "Agent instruction paths must not contain symbolic links.",
              path: path.join(instructionPath, file),
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
        return yield* new AgentDefinitionError({
          message: "Agent has no Markdown instructions.",
          path: directory,
        });
      }
      return instructions;
    });

    const readSkills = Effect.fn("AgentDefinitionService.readSkills")(function* (
      definition: AgentDefinition,
    ) {
      if (!definition.slots.includes("skills")) return [];
      const directory = path.join(projectRoot, definition.directory, "skills");
      const names = yield* fs.readDirectory(directory);
      return yield* Effect.forEach(
        names.toSorted(),
        Effect.fnUntraced(function* (name) {
          const skillDirectory = path.join(directory, name);
          const realDirectory = yield* fs.realPath(skillDirectory).pipe(Effect.option);
          if (
            Option.isNone(realDirectory) ||
            realDirectory.value !== skillDirectory ||
            (yield* fs.stat(skillDirectory)).type !== "Directory"
          ) {
            return yield* new AgentDefinitionError({
              message: "Agent skills must be non-symbolic Eve-style directories.",
              path: skillDirectory,
            });
          }
          const filePath = path.join(skillDirectory, "SKILL.md");
          const realPath = yield* fs.realPath(filePath).pipe(Effect.option);
          if (Option.isNone(realPath) || realPath.value !== filePath) {
            return yield* new AgentDefinitionError({
              message: "Agent skill directories must contain a non-symbolic SKILL.md.",
              path: filePath,
            });
          }
          const contents = yield* fs.readFileString(filePath);
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
          const skillName = yield* decodeAgentSkillName(declaredName).pipe(
            Effect.mapError(
              (cause) =>
                new AgentDefinitionError({
                  message: "Agent skill SKILL.md must declare a valid frontmatter name.",
                  path: filePath,
                  cause,
                }),
            ),
          );
          if (skillName !== name) {
            return yield* new AgentDefinitionError({
              message: `Agent skill frontmatter name ${skillName} must match its directory ${name}.`,
              path: filePath,
            });
          }
          return {
            name: skillName,
            relativePath: path.relative(projectRoot, filePath).split(path.sep).join("/"),
          };
        }),
      );
    });

    return yield* Effect.forEach(definitions, (definition) =>
      Effect.gen(function* () {
        return {
          ...definition,
          instructions: yield* readInstructions(definition),
          skills: yield* readSkills(definition),
        } satisfies ResolvedAgentDefinition;
      }),
    );
  },
  Effect.mapError((cause) =>
    isAgentDefinitionError(cause)
      ? cause
      : new AgentDefinitionError({ message: "Could not resolve agent definitions.", cause }),
  ),
);

export class AgentDefinitionService extends Context.Service<
  AgentDefinitionService,
  {
    readonly list: (
      input: AgentDefinitionsListInput,
    ) => Effect.Effect<ReadonlyArray<AgentDefinition>, AgentDefinitionError>;
  }
>()("t3/agents/AgentDefinitionService") {}

export const layer = Layer.effect(
  AgentDefinitionService,
  Effect.gen(function* () {
    const projects = yield* ProjectionProjectRepository;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const list = Effect.fn("AgentDefinitionService.list")(
      function* (input: AgentDefinitionsListInput) {
        const project = yield* projects.getById({ projectId: input.projectId });
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return yield* new AgentDefinitionError({
            message: `Project ${input.projectId} was not found.`,
          });
        }
        return yield* discoverAgentDefinitions(project.value.workspaceRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      },
      Effect.mapError((cause) =>
        isAgentDefinitionError(cause)
          ? cause
          : new AgentDefinitionError({ message: "Could not list agent folders.", cause }),
      ),
    );
    return AgentDefinitionService.of({ list });
  }),
);
