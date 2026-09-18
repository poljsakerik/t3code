import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import {
  ProviderInstanceId,
  AgentDefinitionError,
  ResolvedAgentDefinition,
  type AgentDefinition,
} from "@t3tools/contracts";
import { classifyAgentRootEntry } from "@t3tools/eve/filesystem";
import { collectFlatSlotCandidates, collectNamedSlotCandidates } from "@t3tools/eve/slots";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const requireAgent = NodeModule.createRequire(import.meta.url);

const AgentConfiguration = Schema.Struct({
  model: Schema.String.check(Schema.isPattern(/^(?:openai|anthropic)\/[^\s/]+$/)),
  description: Schema.optional(Schema.String),
});
const decodeConfiguration = Schema.decodeUnknownEffect(AgentConfiguration, {
  onExcessProperty: "error",
});
const decodeDefinition = Schema.decodeUnknownEffect(ResolvedAgentDefinition);
const isAgentDefinitionError = Schema.is(AgentDefinitionError);

/** Loads trusted agent configuration; execution remains owned by T3's provider harness. */
export const loadAgentDefinition = Effect.fn("loadAgentDefinition")(
  function* (workspaceRoot: string, definition: AgentDefinition) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(workspaceRoot);
    const directory = path.resolve(root, definition.directory);
    const relative = path.relative(path.join(root, ".t3"), directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* new AgentDefinitionError({
        path: definition.directory,
        message: "Agent definitions must be inside the project's .t3 directory.",
      });
    }
    const assertLocal = Effect.fn("AgentDefinitionLoader.assertLocal")(function* (
      filePath: string,
    ) {
      if ((yield* fs.realPath(filePath)) !== filePath) {
        return yield* new AgentDefinitionError({
          path: filePath,
          message: "Agent source paths must not contain symbolic links.",
        });
      }
    });
    const readEntries = Effect.fn("AgentDefinitionLoader.readEntries")(function* (
      directory: string,
    ) {
      yield* assertLocal(directory);
      return yield* Effect.forEach(
        (yield* fs.readDirectory(directory)).toSorted(),
        Effect.fnUntraced(function* (name) {
          const filePath = path.join(directory, name);
          yield* assertLocal(filePath);
          const info = yield* fs.stat(filePath);
          return { name, type: info.type, isFile: () => info.type === "File" };
        }),
      );
    });
    const entries = yield* readEntries(directory);
    for (const entry of entries) {
      const kind = classifyAgentRootEntry(
        entry.name,
        entry.type === "File" ? "file" : entry.type === "Directory" ? "directory" : "other",
      );
      if (kind === "memory-module") {
        return yield* new AgentDefinitionError({
          path: path.join(directory, entry.name),
          message: "Executable agent memory cannot run through the T3 provider harness.",
        });
      }
      if (
        entry.type !== "Directory" ||
        [
          "unknown",
          "ignored-directory",
          "instructions-directory",
          "skills-directory",
          "subagents-directory",
        ].includes(kind)
      )
        continue;
      if ((yield* fs.readDirectory(path.join(directory, entry.name))).length > 0) {
        return yield* new AgentDefinitionError({
          path: path.join(directory, entry.name),
          message: `Agent ${definition.name} has an authored ${entry.name}/ capability, which cannot run through the T3 provider harness.`,
        });
      }
    }

    const readSlot = Effect.fn("AgentDefinitionLoader.readSlot")(function* (
      candidates: {
        readonly markdownFileName?: string;
        readonly moduleFileNames: ReadonlyArray<string>;
      },
      parent: string,
    ) {
      if (candidates.moduleFileNames.length > 0) {
        return yield* new AgentDefinitionError({
          path: parent,
          message:
            candidates.markdownFileName !== undefined || candidates.moduleFileNames.length > 1
              ? "Conflicting authored agent instruction sources."
              : "Executable agent instructions cannot run through the T3 provider harness; use Markdown instructions.",
        });
      }
      return candidates.markdownFileName === undefined
        ? ""
        : yield* fs.readFileString(path.join(parent, candidates.markdownFileName));
    });
    const flat = collectFlatSlotCandidates(entries, {
      markdownFileName: "instructions.md",
      moduleBaseName: "instructions",
    });
    const hasDirectory = entries.some(
      (entry) => entry.name === "instructions" && entry.type === "Directory",
    );
    const parts: Array<string> = [];
    // Eve puts the flat instruction first, then named instructions in stable slot order.
    parts.push(yield* readSlot(flat, directory));
    if (hasDirectory) {
      const instructionDirectory = path.join(directory, "instructions");
      const children = yield* readEntries(instructionDirectory);
      const slots = collectNamedSlotCandidates(children, {
        allowMarkdown: true,
        allowModules: true,
      });
      for (const slot of slots) parts.push(yield* readSlot(slot, instructionDirectory));
    } else if (flat.markdownFileName === undefined && flat.moduleFileNames.length === 0) {
      // Eve supports the legacy system slot only when there are no modern instructions.
      parts.push(
        yield* readSlot(
          collectFlatSlotCandidates(entries, {
            markdownFileName: "system.md",
            moduleBaseName: "system",
          }),
          directory,
        ),
      );
    }
    const instructions = parts
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .trim();
    if (instructions.length === 0) {
      return yield* new AgentDefinitionError({
        path: directory,
        message: "Agent has no Markdown instructions.",
      });
    }

    const config = collectFlatSlotCandidates(entries, { moduleBaseName: "agent" });
    if (config.moduleFileNames.length !== 1) {
      return yield* new AgentDefinitionError({
        path: directory,
        message:
          "Agent requires exactly one agent.ts (or supported JavaScript module) declaring its model.",
      });
    }
    const configPath = path.join(directory, config.moduleFileNames[0]!);
    const source = yield* fs.readFileString(configPath);
    const configuration = yield* Effect.tryPromise({
      try: async () => {
        // CommonJS ignores URL queries and maintains a separate cache from ESM.
        delete requireAgent.cache[configPath];
        const moduleUrl = `${NodeURL.pathToFileURL(configPath).href}?t3=${NodeCrypto.createHash("sha256").update(source).digest("hex")}`;
        // Node 22.16 (our minimum) has the stripping API but does not enable it by
        // default. Scope the hook to this source so desktop and CLI load it alike.
        const hooks = NodeModule.registerHooks({
          load(url, context, nextLoad) {
            if (url !== moduleUrl || !/\.(?:cts|mts|ts)$/.test(configPath))
              return nextLoad(url, context);
            return {
              format: configPath.endsWith(".cts") ? "commonjs" : "module",
              source: NodeModule.stripTypeScriptTypes(source),
              shortCircuit: true,
            };
          },
        });
        try {
          return (await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown };
        } finally {
          hooks.deregister();
        }
      },
      catch: (cause) =>
        new AgentDefinitionError({
          path: configPath,
          message: "Could not import agent configuration.",
          cause,
        }),
    }).pipe(
      Effect.flatMap((module) => decodeConfiguration(module.default)),
      Effect.mapError((cause) =>
        isAgentDefinitionError(cause)
          ? cause
          : new AgentDefinitionError({
              path: configPath,
              message:
                "Agent configuration must declare an openai/<model> or anthropic/<model> string. Only model and description are supported by the T3 harness; executable Eve model and capability settings are not supported.",
              cause,
            }),
      ),
    );
    const [provider, model] = configuration.model.split("/");
    const modelSelection = {
      instanceId: ProviderInstanceId.make(provider === "anthropic" ? "claudeAgent" : "codex"),
      model: model!,
    };

    const skills: Array<string> = [];
    if (entries.some((entry) => entry.name === "skills" && entry.type === "Directory")) {
      const skillDirectory = path.join(directory, "skills");
      for (const entry of yield* readEntries(skillDirectory)) {
        if (entry.type === "Directory") skills.push(entry.name);
        else if (entry.type === "File" && entry.name.toLowerCase().endsWith(".md"))
          skills.push(entry.name.slice(0, -3));
        else
          return yield* new AgentDefinitionError({
            path: path.join(skillDirectory, entry.name),
            message:
              "Agent skills must be Markdown files or directories named for a native harness skill.",
          });
      }
    }
    return yield* decodeDefinition({
      id: definition.id,
      name: definition.name,
      instructions,
      skills,
      modelSelection,
    });
  },
  Effect.mapError((cause) =>
    isAgentDefinitionError(cause)
      ? cause
      : new AgentDefinitionError({ message: "Could not load agent definition.", cause }),
  ),
);
