import {
  AgentSkillInstallInput,
  AgentSkillRemoveInput,
  type AgentInstalledSkill,
  type ResolvedAgentDefinition,
  agentDefinitionKey,
  type AgentCatalogInput,
  type AgentCatalogResult,
} from "@t3tools/contracts";
import { loadAgentDefinition } from "./AgentDefinitionLoader.ts";
import { downloadAgentSkill } from "./AgentSkills.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as NodeOS from "node:os";
import {
  AgentDefinitionError,
  type AgentDefinition,
  type AgentDefinitionsListInput,
  type AgentDefinitionsListResult,
  type AgentDefinitionGetInput,
  type AgentDefinitionGetResult,
  AgentDefinitionCreateInput,
  type AgentDefinitionUpdateInput,
  type AgentInstructionDocument,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Result from "effect/Result";
import type { PlatformError } from "effect/PlatformError";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";

const isAgentDefinitionError = Schema.is(AgentDefinitionError);
const decodeSkillInstall = Schema.decodeEffect(AgentSkillInstallInput);
const decodeSkillRemove = Schema.decodeEffect(AgentSkillRemoveInput);
const decodeCreateInput = Schema.decodeEffect(AgentDefinitionCreateInput);

import {
  classifyAgentRootEntry,
  isDiscoverableAgentRootEntry,
  matchesSupportedModuleBaseName,
  type DirectoryEntryType,
} from "@t3tools/eve/filesystem";

const entryType = (type: string): DirectoryEntryType =>
  type === "File" ? "file" : type === "Directory" ? "directory" : "other";
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
      if (instructionPaths.length === 0) {
        instructionPaths.push(
          ...children
            .filter((entry) => {
              const kind = classifyAgentRootEntry(entry.name, entryType(entry.type));
              return kind === "system-markdown" || kind === "system-module";
            })
            .map((entry) => relative(path.join(directory, entry.name))),
        );
      }
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

export class AgentDefinitionService extends Context.Service<
  AgentDefinitionService,
  {
    readonly catalog: (
      input: AgentCatalogInput,
    ) => Effect.Effect<AgentCatalogResult, AgentDefinitionError>;
    readonly resolve: (
      input: AgentDefinitionGetInput,
    ) => Effect.Effect<ResolvedAgentDefinition, AgentDefinitionError>;
    readonly installSkill: (
      input: AgentSkillInstallInput,
    ) => Effect.Effect<AgentDefinitionGetResult, AgentDefinitionError>;
    readonly removeSkill: (
      input: AgentSkillRemoveInput,
    ) => Effect.Effect<AgentDefinitionGetResult, AgentDefinitionError>;
    readonly get: (
      input: AgentDefinitionGetInput,
    ) => Effect.Effect<AgentDefinitionGetResult, AgentDefinitionError>;
    readonly create: (
      input: AgentDefinitionCreateInput,
    ) => Effect.Effect<AgentDefinition, AgentDefinitionError>;
    readonly update: (
      input: AgentDefinitionUpdateInput,
    ) => Effect.Effect<AgentDefinition, AgentDefinitionError>;
    readonly list: (
      input: AgentDefinitionsListInput,
    ) => Effect.Effect<AgentDefinitionsListResult, AgentDefinitionError>;
  }
>()("t3/agents/AgentDefinitionService") {}

export const layer = Layer.effect(
  AgentDefinitionService,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const projects = yield* ProjectionProjectRepository;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const wrapError = (cause: unknown) =>
      isAgentDefinitionError(cause)
        ? cause
        : new AgentDefinitionError({ message: "Could not access agent files.", cause });
    const workspace = Effect.fn("AgentDefinitionService.workspace")(function* (
      input: AgentDefinitionsListInput,
    ) {
      const home = yield* fs.realPath(NodeOS.homedir());
      if (input.projectId === undefined) return home;
      const project = yield* projects.getById({ projectId: input.projectId });
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* new AgentDefinitionError({
          message: `Project ${input.projectId} was not found.`,
        });
      }
      return yield* fs.realPath(project.value.workspaceRoot);
    });
    const discover = (root: string) =>
      discoverAgentDefinitions(root).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const findAgent = Effect.fn("AgentDefinitionService.findAgent")(function* (
      root: string,
      id: string,
    ) {
      const agent = (yield* discover(root)).find((agent) => agent.id === id);
      if (!agent)
        return yield* new AgentDefinitionError({
          message: "Agent was not found. Refresh the catalog and try again.",
        });
      return agent;
    });
    const readDocument = Effect.fn("AgentDefinitionService.readDocument")(function* (file: string) {
      if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).type !== "File") {
        return yield* new AgentDefinitionError({
          message: "Linked instruction sources cannot be edited.",
          path: file,
        });
      }
      if ((yield* fs.stat(file)).size > 4_000_000) {
        return yield* new AgentDefinitionError({
          message: "Instruction files must contain at most 1,000,000 characters.",
          path: file,
        });
      }
      const content = yield* fs.readFileString(file);
      if (content.length > 1_000_000) {
        return yield* new AgentDefinitionError({
          message: "Instruction files must contain at most 1,000,000 characters.",
          path: file,
        });
      }
      return content;
    });
    const getAt = Effect.fn("AgentDefinitionService.getAt")(function* (
      root: string,
      agentId: string,
    ) {
      const agent = yield* findAgent(root, agentId);
      const documents: AgentInstructionDocument[] = [];
      const otherInstructionPaths: string[] = [];
      const visit = Effect.fn("AgentDefinitionService.visitInstructions")(function* (
        relative: string,
        allowDirectory = true,
      ): Effect.fn.Return<void, AgentDefinitionError | PlatformError> {
        const file = path.join(root, relative);
        if ((yield* fs.realPath(file)) !== file) {
          otherInstructionPaths.push(relative);
          return;
        }
        const stat = yield* fs.stat(file);
        if (stat.type === "Directory" && allowDirectory) {
          for (const name of (yield* fs.readDirectory(file)).toSorted()) {
            yield* visit(`${relative}/${name}`, false);
          }
        } else if (stat.type === "File" && relative.toLowerCase().endsWith(".md")) {
          documents.push({ path: relative, content: yield* readDocument(file) });
        } else {
          otherInstructionPaths.push(relative);
        }
      });
      for (const source of agent.instructionPaths) yield* visit(source);
      if (
        documents.length === 0 &&
        !agent.instructionPaths.some(
          (source) =>
            matchesSupportedModuleBaseName(path.basename(source), "instructions") ||
            matchesSupportedModuleBaseName(path.basename(source), "system"),
        )
      ) {
        documents.push({ path: `${agent.directory}/instructions.md`, content: null });
      }
      const installedSkills: AgentInstalledSkill[] = [];
      const skillsDirectory = path.join(root, agent.directory, "skills");
      if (yield* fs.exists(skillsDirectory)) {
        if ((yield* fs.realPath(skillsDirectory)) !== skillsDirectory) {
          return yield* new AgentDefinitionError({
            message: "Linked skill folders cannot be managed.",
          });
        }
        for (const name of (yield* fs.readDirectory(skillsDirectory)).toSorted()) {
          const directory = path.join(skillsDirectory, name);
          const document = path.join(directory, "SKILL.md");
          if ((yield* fs.realPath(directory)) !== directory) continue;
          if ((yield* fs.stat(directory)).type !== "Directory" || !(yield* fs.exists(document)))
            continue;
          if (
            (yield* fs.realPath(document)) !== document ||
            (yield* fs.stat(document)).type !== "File"
          )
            continue;
          installedSkills.push({ name, path: `${agent.directory}/skills/${name}` });
        }
      }
      return { agent, documents, otherInstructionPaths, installedSkills };
    });
    const list = Effect.fn("AgentDefinitionService.list")(function* (
      input: AgentDefinitionsListInput,
    ) {
      const root = yield* workspace(input);
      return {
        scope:
          root === (yield* fs.realPath(NodeOS.homedir()))
            ? ("global" as const)
            : ("project" as const),
        agents: yield* discover(root),
      };
    }, Effect.mapError(wrapError));
    const get = Effect.fn("AgentDefinitionService.get")(function* (input: AgentDefinitionGetInput) {
      return yield* getAt(yield* workspace(input), input.agentId);
    }, Effect.mapError(wrapError));
    const catalog = Effect.fn("AgentDefinitionService.catalog")(function* (
      input: AgentCatalogInput,
    ) {
      const registered = (yield* projects.listAll()).filter(
        (project) => project.deletedAt === null,
      );
      const sources = [
        { projectId: null, name: "Global" },
        ...registered.map((project) => ({ projectId: project.projectId, name: project.title })),
      ].sort((left, right) => {
        const priority = (projectId: typeof left.projectId) =>
          projectId === input.projectId ? 0 : projectId === null ? 1 : 2;
        return (
          priority(left.projectId) - priority(right.projectId) ||
          left.name.localeCompare(right.name)
        );
      });
      const groups = yield* Effect.forEach(
        sources,
        Effect.fnUntraced(function* (source) {
          const result = yield* Effect.result(
            list(source.projectId === null ? {} : { projectId: source.projectId }),
          );
          if (Result.isFailure(result))
            return { ...source, agents: [], error: result.failure.message };
          // A project registered at home already appears in the Global group.
          if (source.projectId !== null && result.success.scope === "global") return null;
          return { ...source, agents: result.success.agents, error: null };
        }),
        { concurrency: 4 },
      );
      return { groups: groups.filter((group) => group !== null) };
    }, Effect.mapError(wrapError));
    // Check every existing ancestor before creating directories, including the .t3 root.
    const ensureDirectory = Effect.fn("AgentDefinitionService.ensureDirectory")(function* (
      root: string,
      relative: string,
    ) {
      let directory = root;
      for (const segment of relative.split("/")) {
        directory = path.join(directory, segment);
        if (!(yield* fs.exists(directory))) yield* fs.makeDirectory(directory);
        if (
          (yield* fs.realPath(directory)) !== directory ||
          (yield* fs.stat(directory)).type !== "Directory"
        ) {
          return yield* new AgentDefinitionError({
            message: "Linked agent folders cannot be edited.",
            path: relative,
          });
        }
      }
      return directory;
    });
    const create = Effect.fn("AgentDefinitionService.create")(
      function* (request: AgentDefinitionCreateInput) {
        const input = yield* decodeCreateInput(request);
        if (!input.instructions.trim())
          return yield* new AgentDefinitionError({ message: "Add instructions for this agent." });
        const root = yield* workspace(input);
        const agents = yield* discover(root);
        const singleRoot = agents.find((agent) => agent.id === ".t3" || agent.id === ".t3/agent");
        const parentId = input.parentId ?? singleRoot?.id;
        const parent = parentId === undefined ? undefined : yield* findAgent(root, parentId);
        // An empty single-agent folder still takes precedence in Eve discovery.
        const emptyRoot = !parent && (yield* fs.exists(path.join(root, ".t3/agent")));
        const container = parent
          ? `${parent.directory}/subagents`
          : emptyRoot
            ? ".t3/agent/subagents"
            : ".t3/agents";
        const directory = `${container}/${input.name}`;
        yield* ensureDirectory(root, container);
        if (yield* fs.exists(path.join(root, directory))) {
          return yield* new AgentDefinitionError({
            message: "An agent with this name already exists.",
          });
        }
        yield* fs.makeDirectory(path.join(root, directory));
        yield* fs
          .writeFileString(path.join(root, directory, "instructions.md"), input.instructions, {
            flag: "wx",
          })
          .pipe(
            Effect.onError(() =>
              fs.remove(path.join(root, directory), { recursive: true }).pipe(Effect.ignore),
            ),
          );
        return yield* findAgent(root, directory);
      },
      lock.withPermits(1),
      Effect.mapError(wrapError),
    );
    const update = Effect.fn("AgentDefinitionService.update")(
      function* (input: AgentDefinitionUpdateInput) {
        const root = yield* workspace(input);
        const current = yield* getAt(root, input.agentId);
        const document = current.documents.find((document) => document.path === input.path);
        if (!document)
          return yield* new AgentDefinitionError({
            message: "Only this agent's Markdown instruction sources can be edited.",
          });
        if (document.content !== input.expectedContent) {
          return yield* new AgentDefinitionError({
            message:
              "These instructions changed since you opened the editor. Reopen the editor to load the latest version before saving.",
          });
        }
        const file = path.join(root, document.path);
        if (document.content === null) {
          yield* fs.writeFileString(file, input.content, { flag: "wx" });
        } else {
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(file),
            prefix: ".t3-instructions-",
          });
          const staged = path.join(temporary, "instructions.md");
          yield* fs.writeFileString(staged, input.content);
          yield* fs.rename(staged, file);
        }
        return yield* findAgent(root, input.agentId);
      },
      Effect.scoped,
      lock.withPermits(1),
      Effect.mapError(wrapError),
    );
    const installSkill = Effect.fn("AgentDefinitionService.installSkill")(
      function* (request: AgentSkillInstallInput) {
        const input = yield* decodeSkillInstall(request);
        const root = yield* workspace(input);
        const agent = yield* findAgent(root, input.agentId);
        const skillsDirectory = yield* ensureDirectory(root, `${agent.directory}/skills`);
        if ((yield* fs.readDirectory(skillsDirectory)).length >= 20)
          return yield* new AgentDefinitionError({
            message: "An agent can have at most 20 skills. Remove one before adding another.",
          });
        const destination = path.join(skillsDirectory, input.name);
        if ((yield* fs.exists(destination)) || (yield* fs.exists(`${destination}.md`))) {
          return yield* new AgentDefinitionError({
            message:
              "This agent already has a skill with that name. Remove it before installing a replacement.",
          });
        }
        const downloaded = yield* downloadAgentSkill(input).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner, runner),
        );
        // Stage on the destination filesystem so publishing is an atomic rename.
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: path.join(root, agent.directory),
          prefix: ".skill-install-",
        });
        const staged = path.join(staging, input.name);
        yield* fs.copy(downloaded, staged, { overwrite: false });
        // Re-check after the download, which may take a while.
        yield* findAgent(root, input.agentId);
        yield* ensureDirectory(root, `${agent.directory}/skills`);
        if (yield* fs.exists(destination))
          return yield* new AgentDefinitionError({
            message: "This skill was added while the download was running. Refresh the agent.",
          });
        yield* fs.rename(staged, destination);
        return yield* getAt(root, input.agentId);
      },
      Effect.scoped,
      lock.withPermits(1),
      Effect.mapError(wrapError),
    );
    const removeSkill = Effect.fn("AgentDefinitionService.removeSkill")(
      function* (request: AgentSkillRemoveInput) {
        const input = yield* decodeSkillRemove(request);
        const root = yield* workspace(input);
        const current = yield* getAt(root, input.agentId);
        const skill = current.installedSkills.find((skill) => skill.name === input.name);
        if (!skill)
          return yield* new AgentDefinitionError({
            message: "This skill is no longer installed on the agent. Refresh and try again.",
          });
        yield* fs.remove(path.join(root, skill.path), { recursive: true });
        return yield* getAt(root, input.agentId);
      },
      lock.withPermits(1),
      Effect.mapError(wrapError),
    );
    const resolve = Effect.fn("AgentDefinitionService.resolve")(function* (
      input: AgentDefinitionGetInput,
    ) {
      const root = yield* workspace(input);
      const agent = yield* loadAgentDefinition(root, yield* findAgent(root, input.agentId)).pipe(
        Effect.provideService(Path.Path, path),
      );
      return { ...agent, id: agentDefinitionKey(input) };
    }, Effect.mapError(wrapError));
    return AgentDefinitionService.of({
      list,
      catalog,
      get,
      create,
      update,
      installSkill,
      removeSkill,
      resolve,
    });
  }),
);
