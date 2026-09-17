import * as NodeCrypto from "node:crypto";
import {
  AgentDefinitionError,
  AgentDefinitionConfig,
  AgentDefinitionSaveInput,
  type AgentDefinitionGetInput,
  type AgentDefinitionDeleteInput,
  type AgentDefinitionDocument,
  type AgentDefinitionSnapshot,
  type ThreadAgentDefinition,
  type AgentDefinition,
  type AgentDefinitionsListInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { PlatformError } from "effect/PlatformError";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";

const agentSlots = new Set([
  "channels",
  "connections",
  "extensions",
  "hooks",
  "skills",
  "lib",
  "memory",
  "sandbox",
  "tools",
  "schedules",
  "subagents",
]);
const instructionFiles = ["instructions.md", "instructions.ts"];
const isAgentDefinitionError = Schema.is(AgentDefinitionError);
const configJson = Schema.fromJsonString(AgentDefinitionConfig);
const decodeConfig = Schema.decodeUnknownEffect(configJson);
const encodeConfig = Schema.encodeEffect(configJson);
const decodeSave = Schema.decodeUnknownEffect(AgentDefinitionSaveInput);

/** Reads source locations only. Discovering an agent must never execute its TypeScript. */
export const discoverAgentDefinitions = Effect.fn("discoverAgentDefinitions")(
  function* (workspaceRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(workspaceRoot);
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
      path.relative(root, filePath).split(path.sep).join("/") || ".";
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
      const instructionPaths = instructionFiles
        .filter((file) => files.has(file))
        .map((file) => relative(path.join(directory, file)));
      if (directories.has("instructions"))
        instructionPaths.push(relative(path.join(directory, "instructions")));
      if (!files.has("agent.ts") && !files.has("agent.json") && instructionPaths.length === 0)
        return;
      const id = relative(directory);
      definitions.push({
        id,
        name,
        directory: id,
        parentId,
        configurationPath: files.has("agent.json")
          ? relative(path.join(directory, "agent.json"))
          : files.has("agent.ts")
            ? relative(path.join(directory, "agent.ts"))
            : null,
        instructionPaths,
        slots: children
          .filter((entry) => entry.type === "Directory" && agentSlots.has(entry.name))
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
      yield* scan(path.join(root, "agent"), path.basename(root), null);
    } else if (
      rootEntries.some(
        (entry) =>
          entry.type === "File" &&
          ["agent.ts", "agent.json", ...instructionFiles].includes(entry.name),
      ) ||
      rootEntries.some((entry) => entry.name === "instructions" && entry.type === "Directory")
    ) {
      yield* scan(root, path.basename(root), null);
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

export class AgentDefinitionService extends Context.Service<
  AgentDefinitionService,
  {
    readonly get: (
      input: AgentDefinitionGetInput,
    ) => Effect.Effect<AgentDefinitionDocument, AgentDefinitionError>;
    readonly save: (
      input: AgentDefinitionSaveInput,
    ) => Effect.Effect<AgentDefinitionDocument, AgentDefinitionError>;
    readonly delete: (
      input: AgentDefinitionDeleteInput,
    ) => Effect.Effect<void, AgentDefinitionError>;
    readonly resolve: (
      input: AgentDefinitionGetInput,
    ) => Effect.Effect<ThreadAgentDefinition, AgentDefinitionError>;
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
    const lock = yield* Semaphore.make(1);
    const joinRelative = (...parts: Array<string>) =>
      path
        .join(...parts)
        .split(path.sep)
        .join("/");
    const failure = (message: string, filePath?: string) =>
      new AgentDefinitionError({ message, ...(filePath ? { path: filePath } : {}) });
    const mapError = (cause: unknown) =>
      isAgentDefinitionError(cause)
        ? cause
        : new AgentDefinitionError({ message: "Could not access agent files.", cause });
    const rootFor = Effect.fn("AgentDefinitionService.rootFor")(function* (
      projectId: AgentDefinitionsListInput["projectId"],
    ) {
      const project = yield* projects.getById({ projectId });
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* failure(`Project ${projectId} was not found.`);
      }
      return yield* fs.realPath(project.value.workspaceRoot);
    });
    const discover = (root: string) =>
      discoverAgentDefinitions(root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const readOptional = (filePath: string) =>
      fs
        .readFileString(filePath)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
    const safePath = Effect.fn("AgentDefinitionService.safePath")(function* (
      root: string,
      relativePath: string,
    ) {
      const absolute = path.resolve(root, relativePath);
      if (absolute !== root && !absolute.startsWith(root + path.sep))
        return yield* failure("Agent path is outside the project.", relativePath);
      // Resolve existing ancestors too, so writes cannot follow a newly introduced symlink.
      const link = yield* fs.readLink(absolute).pipe(Effect.option);
      if (Option.isSome(link))
        return yield* failure("Agent paths must not contain symbolic links.", relativePath);
      let ancestor = absolute;
      while (!(yield* fs.exists(ancestor))) ancestor = path.dirname(ancestor);
      if ((yield* fs.realPath(ancestor)) !== ancestor)
        return yield* failure("Agent paths must not contain symbolic links.", relativePath);
      return absolute;
    });
    const find = Effect.fn("AgentDefinitionService.find")(function* (
      input: AgentDefinitionGetInput,
    ) {
      const root = yield* rootFor(input.projectId);
      const definitions = yield* discover(root);
      const definition = definitions.find((entry) => entry.id === input.id);
      if (!definition) return yield* failure(`Agent ${input.id} was not found.`);
      return { root, definition };
    });
    const readDocument = Effect.fn("AgentDefinitionService.readDocument")(function* (
      root: string,
      definition: AgentDefinition,
    ) {
      const configPath = yield* safePath(root, path.join(definition.directory, "agent.json"));
      const instructionsPath = yield* safePath(
        root,
        path.join(definition.directory, "instructions.md"),
      );
      const configText = yield* readOptional(configPath);
      const instructions = (yield* readOptional(instructionsPath)) ?? "";
      const config =
        configText === null
          ? { version: 1 as const, name: definition.name, description: "" }
          : yield* decodeConfig(configText);
      const revision = NodeCrypto.createHash("sha256")
        .update(String(configText?.length ?? -1))
        .update(":")
        .update(configText ?? "")
        .update(instructions)
        .digest("hex");
      return { definition, config, instructions, revision } satisfies AgentDefinitionDocument;
    });
    const get = Effect.fn("AgentDefinitionService.get")(function* (input: AgentDefinitionGetInput) {
      const { root, definition } = yield* find(input);
      return yield* readDocument(root, definition);
    }, Effect.mapError(mapError));
    const requireEditable = (definition: AgentDefinition) =>
      definition.instructionPaths.some((file) => !file.endsWith("instructions.md")) ||
      definition.configurationPath?.endsWith(".ts")
        ? Effect.fail(
            failure(
              "Convert this agent to instructions.md and agent.json before editing it in T3.",
            ),
          )
        : Effect.void;
    const atomicWrite = Effect.fn("AgentDefinitionService.atomicWrite")(function* (
      filePath: string,
      contents: string,
    ) {
      const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
      yield* fs
        .writeFileString(temporary, contents)
        .pipe(
          Effect.andThen(fs.rename(temporary, filePath)),
          Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        );
    });
    const save = Effect.fn("AgentDefinitionService.save")(
      function* (raw: AgentDefinitionSaveInput) {
        const input = yield* decodeSave(raw);
        const root = yield* rootFor(input.projectId);
        let id: string;
        if (input.target.type === "update") {
          const current = yield* get({ projectId: input.projectId, id: input.target.id });
          yield* requireEditable(current.definition);
          if (current.revision !== input.target.expectedRevision)
            return yield* failure("This agent changed. Reload it before saving.");
          id = current.definition.id;
        } else {
          const definitions = yield* discover(root);
          if (input.target.parentId !== null) {
            const parentId = input.target.parentId;
            const parent = definitions.find((entry) => entry.id === parentId);
            if (!parent) return yield* failure("The parent agent no longer exists.");
            id = joinRelative(parent.directory, "subagents", input.target.slug);
          } else {
            if (
              definitions.some(
                (entry) => entry.parentId === null && !entry.directory.startsWith("agents/"),
              )
            ) {
              return yield* failure(
                "This project has a single root agent. Add a subagent, or move the root into agents/<name>/agent/ to add more roots.",
              );
            }
            id = `agents/${input.target.slug}/agent`;
            if (yield* fs.exists(path.join(root, "agent")))
              return yield* failure(
                "An agent/ directory already exists. Use that root or move it into agents/ first.",
              );
            if (
              (yield* fs.exists(path.join(root, "agents", input.target.slug))) &&
              (yield* fs.readDirectory(path.join(root, "agents", input.target.slug))).length > 0
            )
              return yield* failure("That agent folder already exists.");
          }
          const directory = yield* safePath(root, id);
          if (yield* fs.exists(directory))
            return yield* failure("That agent folder already exists.");
          yield* fs.makeDirectory(directory, { recursive: true });
        }
        const instructionsPath = yield* safePath(root, path.join(id, "instructions.md"));
        const configPath = yield* safePath(root, path.join(id, "agent.json"));
        yield* atomicWrite(instructionsPath, input.instructions);
        yield* atomicWrite(configPath, (yield* encodeConfig(input.config)) + "\n");
        return yield* get({ projectId: input.projectId, id });
      },
      lock.withPermits(1),
      Effect.mapError(mapError),
    );
    const remove = Effect.fn("AgentDefinitionService.delete")(
      function* (input: AgentDefinitionDeleteInput) {
        const { root, definition } = yield* find(input);
        if (definition.directory === ".")
          return yield* failure(
            "Remove flat agent files manually; T3 will not delete the project directory.",
          );
        const document = yield* readDocument(root, definition);
        if (document.revision !== input.expectedRevision)
          return yield* failure("This agent changed. Reload it before deleting.");
        yield* fs.remove(yield* safePath(root, definition.directory), { recursive: true });
      },
      lock.withPermits(1),
      Effect.mapError(mapError),
    );
    const markdownFiles = Effect.fn("AgentDefinitionService.markdownFiles")(function* (
      root: string,
      directory: string,
    ) {
      const absolute = yield* safePath(root, directory);
      if (!(yield* fs.exists(absolute))) return [];
      const files = yield* fs.readDirectory(absolute, { recursive: true });
      const result: Array<string> = [];
      for (const file of files.toSorted()) {
        if (!file.endsWith(".md")) continue;
        const relativePath = joinRelative(directory, file.split(path.sep).join("/"));
        const resolved = yield* safePath(root, relativePath);
        if ((yield* fs.stat(resolved)).type === "File") result.push(relativePath);
      }
      return result;
    });
    const resolve = Effect.fn("AgentDefinitionService.resolve")(function* (
      input: AgentDefinitionGetInput,
    ) {
      const { root, definition } = yield* find(input);
      const definitions = (yield* discover(root)).filter(
        (entry) =>
          entry.id === definition.id ||
          entry.id.startsWith(`${definition.id === "." ? "" : definition.id + "/"}subagents/`),
      );
      const snapshots: Array<AgentDefinitionSnapshot> = [];
      for (const entry of definitions) {
        const directory = yield* safePath(root, entry.directory);
        // These slots need Eve's runtime. Never silently run a different agent by ignoring them.
        for (const file of [
          "agent.ts",
          "instructions.ts",
          "sandbox.ts",
          "memory.ts",
          "instrumentation.ts",
        ]) {
          if (yield* fs.exists(path.join(directory, file)))
            return yield* failure(
              `${entry.name} uses ${file}, which requires the Eve runtime. Use agent.json and Markdown instructions for T3 providers.`,
              entry.directory,
            );
        }
        for (const slot of [
          "tools",
          "connections",
          "extensions",
          "hooks",
          "sandbox",
          "memory",
          "schedules",
          "channels",
        ]) {
          if (
            entry.slots.includes(slot) &&
            (yield* fs.readDirectory(path.join(directory, slot))).length > 0
          )
            return yield* failure(
              `${entry.name} has an authored ${slot}/ slot. T3 provider execution does not support that slot yet.`,
              entry.directory,
            );
        }
        const document = yield* readDocument(root, entry);
        const parts = [document.instructions];
        if (
          entry.instructionPaths.some(
            (file) => file.endsWith("/instructions") || file === "instructions",
          )
        ) {
          const instructionDirectory = joinRelative(entry.directory, "instructions");
          const all = yield* fs.readDirectory(path.join(root, instructionDirectory), {
            recursive: true,
          });
          if (all.some((file) => file.endsWith(".ts")))
            return yield* failure(
              "TypeScript instructions require the Eve runtime.",
              entry.directory,
            );
          for (const file of yield* markdownFiles(root, instructionDirectory))
            parts.push(yield* fs.readFileString(path.join(root, file)));
        }
        const skillsDirectory = joinRelative(entry.directory, "skills");
        if (entry.slots.includes("skills")) {
          const skillEntries = yield* fs.readDirectory(path.join(root, skillsDirectory));
          if (skillEntries.some((file) => file.endsWith(".ts")))
            return yield* failure(
              "TypeScript skill modules require the Eve runtime.",
              entry.directory,
            );
        }
        const skillPaths = (yield* markdownFiles(root, skillsDirectory)).filter(
          (file) =>
            file.endsWith("/SKILL.md") ||
            file.slice(skillsDirectory.length + 1).indexOf("/") === -1,
        );
        const instructions = parts.filter(Boolean).join("\n\n");
        if (instructions.length > 64_000)
          return yield* failure(
            "Agent instructions must be at most 64,000 characters.",
            entry.directory,
          );
        snapshots.push({
          id: entry.id,
          parentId: entry.parentId,
          config: document.config,
          instructions,
          skillPaths,
        });
      }
      const active = snapshots.find((entry) => entry.id === definition.id);
      if (!active) return yield* failure("The agent disappeared while loading.");
      return {
        definition: active,
        descendants: snapshots.filter((entry) => entry !== active),
      } satisfies ThreadAgentDefinition;
    }, Effect.mapError(mapError));
    const list = Effect.fn("AgentDefinitionService.list")(function* (
      input: AgentDefinitionsListInput,
    ) {
      const root = yield* rootFor(input.projectId);
      const definitions = yield* discover(root);
      return yield* Effect.forEach(
        definitions,
        Effect.fnUntraced(function* (definition) {
          if (!definition.configurationPath?.endsWith(".json")) return definition;
          const config = yield* readOptional(yield* safePath(root, definition.configurationPath));
          if (config === null) return definition;
          const decoded = yield* decodeConfig(config).pipe(Effect.option);
          return Option.isSome(decoded) ? { ...definition, name: decoded.value.name } : definition;
        }),
        { concurrency: 8 },
      );
    }, Effect.mapError(mapError));
    return AgentDefinitionService.of({
      list: (input) => list(input).pipe(lock.withPermits(1)),
      get: (input) => get(input).pipe(lock.withPermits(1)),
      save,
      delete: remove,
      resolve: (input) => resolve(input).pipe(lock.withPermits(1)),
    });
  }),
);
