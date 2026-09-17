import {
  AgentDefinitionError,
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
import type { PlatformError } from "effect/PlatformError";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";

const isAgentDefinitionError = Schema.is(AgentDefinitionError);

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
      if (!files.has("agent.ts") && instructionPaths.length === 0) return;
      const id = relative(directory);
      definitions.push({
        id,
        name,
        directory: id,
        parentId,
        configurationPath: files.has("agent.ts")
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
        (entry) => entry.type === "File" && ["agent.ts", ...instructionFiles].includes(entry.name),
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
