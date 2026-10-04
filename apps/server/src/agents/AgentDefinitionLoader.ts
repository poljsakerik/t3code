import { createDiskProjectSource } from "@t3tools/eve/project-source";
import * as Path from "effect/Path";
import {
  AgentMcpConnection,
  AgentMcpConnections,
  ProviderInstanceId,
  AgentDefinitionError,
  ResolvedAgentDefinition,
  type AgentDefinition,
} from "@t3tools/contracts";
import { discoverAgent } from "@t3tools/eve/discover";
import { loadAgentConfiguration, loadAgentModule } from "@t3tools/eve/load-module";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const AgentConfiguration = Schema.Struct({
  model: Schema.String.check(Schema.isPattern(/^(?:openai|anthropic)\/[^\s/]+$/)),
  description: Schema.optional(Schema.String),
});
const decodeConfiguration = Schema.decodeUnknownEffect(AgentConfiguration, {
  onExcessProperty: "error",
});
// Eve helpers stamp definitions with non-enumerable identity and protocol symbols.
const decodeAuthoredMcpConnection = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...AgentMcpConnection.fields,
    [Symbol.for("eve.connection-protocol")]: Schema.optional(Schema.Literal("mcp")),
    [Symbol.for("eve.definition-source-key")]: Schema.optional(Schema.String),
  }),
  { onExcessProperty: "error" },
);
const decodeMcpConnections = Schema.decodeUnknownEffect(AgentMcpConnections, {
  onExcessProperty: "error",
});
const decodeDefinition = Schema.decodeUnknownEffect(ResolvedAgentDefinition);
const decodeSkillNames = Schema.decodeEffect(ResolvedAgentDefinition.fields.skills);
const isAgentDefinitionError = Schema.is(AgentDefinitionError);

/** Translates Eve's source definition into the subset supported by T3's harnesses. */
export const loadAgentDefinition = Effect.fn("loadAgentDefinition")(
  function* (
    workspaceRoot: string,
    definition: AgentDefinition,
    options?: {
      readonly retainSkill?: (
        directory: string,
        name: string,
      ) => Effect.Effect<string, AgentDefinitionError>;
    },
  ) {
    const path = yield* Path.Path;
    const manifest = yield* Effect.tryPromise({
      try: () =>
        discoverAgent({
          agentRoot: path.resolve(workspaceRoot, definition.directory),
          boundaryRoot: path.join(workspaceRoot, ".t3"),
        }),
      catch: (cause) =>
        new AgentDefinitionError({
          path: definition.directory,
          message: `Could not discover agent sources: ${String(cause)}`,
          cause,
        }),
    });
    for (const capability of manifest.capabilities) {
      return yield* new AgentDefinitionError({
        path: path.join(manifest.agentRoot, capability.logicalPath),
        message: `Agent ${definition.name} has an authored ${capability.slot} capability, which cannot run through the T3 provider harness.`,
      });
    }
    const connectionExports: Record<string, unknown> = {};
    for (const connection of manifest.connections) {
      if (connection.name === "t3-code")
        return yield* new AgentDefinitionError({
          path: connection.logicalPath,
          message: "The MCP connection name t3-code is reserved for T3's runner.",
        });
      const connectionExport = yield* Effect.tryPromise({
        try: () => loadAgentModule(manifest.agentRoot, connection.logicalPath),
        catch: (cause) =>
          new AgentDefinitionError({
            path: connection.logicalPath,
            message: `Could not import MCP connection ${connection.name}.`,
            cause,
          }),
      });
      const connectionConfig = yield* decodeAuthoredMcpConnection(connectionExport).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDefinitionError({
              path: connection.logicalPath,
              message:
                "MCP connections require an HTTP(S) url, description, and optional static string headers. Eve auth callbacks, tool filters, approvals, and other runtime settings are not supported by T3's runner.",
              cause,
            }),
        ),
      );
      connectionExports[connection.name] = {
        url: connectionConfig.url,
        description: connectionConfig.description,
        ...(connectionConfig.headers === undefined ? {} : { headers: connectionConfig.headers }),
      };
    }
    const mcpConnections = yield* decodeMcpConnections(connectionExports).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDefinitionError({
            path: path.join(manifest.agentRoot, "connections"),
            message:
              "MCP connection names must start with a letter and contain only letters, digits, hyphens, or underscores.",
            cause,
          }),
      ),
    );
    const parts: string[] = [];
    for (const instruction of manifest.instructions) {
      if (instruction.sourceKind === "module") {
        return yield* new AgentDefinitionError({
          path: path.join(manifest.agentRoot, instruction.logicalPath),
          message:
            "Executable agent instructions cannot run through the T3 provider harness; use Markdown instructions.",
        });
      }
      parts.push(instruction.definition.content);
    }
    const baseInstructions = parts
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .trim();
    if (baseInstructions.length === 0) {
      return yield* new AgentDefinitionError({
        path: manifest.agentRoot,
        message: "Agent has no Markdown instructions.",
      });
    }
    yield* decodeSkillNames(manifest.skills.map((skill) => skill.name));
    const source = createDiskProjectSource({ boundaryRoot: manifest.agentRoot });
    const skills: string[] = [];
    for (const skill of manifest.skills) {
      if (skill.sourceKind !== "markdown" && skill.sourceKind !== "directory") {
        return yield* new AgentDefinitionError({
          path: path.join(manifest.agentRoot, skill.logicalPath),
          message:
            "Agent skills must be Markdown files or directories named for a native harness skill.",
        });
      }
      if (skill.sourceKind === "directory") {
        const directory = path.join(manifest.agentRoot, skill.logicalPath);
        const document = path.join(directory, "SKILL.md");
        const content = yield* Effect.tryPromise({
          try: async () =>
            (await source.stat(document)) === "file" ? source.readTextFile(document) : null,
          catch: (cause) =>
            new AgentDefinitionError({
              message: "Could not read this agent's skill instructions.",
              path: document,
              cause,
            }),
        });
        if (content !== null) {
          if (!content.trim() || content.length > 1_000_000)
            return yield* new AgentDefinitionError({
              message: "Skill instructions must contain between 1 and 1,000,000 characters.",
              path: document,
            });
          const resourceDirectory =
            options?.retainSkill === undefined
              ? directory
              : yield* options.retainSkill(directory, skill.name);
          parts.push(
            `## Agent skill: ${skill.name}\nApply these instructions when relevant to your task. Resolve this skill's relative file and script paths from ${resourceDirectory}.\n\n${content}`,
          );
          continue;
        }
      }
      // Legacy Markdown entries and empty folders reference native harness skills.
      skills.push(skill.name);
    }
    if (manifest.configModule === undefined) {
      return yield* new AgentDefinitionError({
        path: manifest.agentRoot,
        message:
          "Agent requires exactly one agent.ts (or supported JavaScript module) declaring its model.",
      });
    }
    const configPath = path.join(manifest.agentRoot, manifest.configModule.logicalPath);
    const configuration = yield* Effect.tryPromise({
      try: () => loadAgentConfiguration(manifest),
      catch: (cause) =>
        new AgentDefinitionError({
          path: configPath,
          message: "Could not import agent configuration.",
          cause,
        }),
    }).pipe(
      Effect.flatMap(decodeConfiguration),
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
    return yield* decodeDefinition({
      id: definition.id,
      name: definition.name,
      instructions: parts
        .filter((part) => part.trim().length > 0)
        .join("\n\n")
        .trim(),
      skills,
      ...(manifest.connections.length === 0 ? {} : { mcpConnections }),
      modelSelection: {
        instanceId: ProviderInstanceId.make(provider === "anthropic" ? "claudeAgent" : "codex"),
        model: model!,
      },
    });
  },
  Effect.mapError((cause) =>
    isAgentDefinitionError(cause)
      ? cause
      : new AgentDefinitionError({ message: "Could not load agent definition.", cause }),
  ),
);
