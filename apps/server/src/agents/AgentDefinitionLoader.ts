import * as Path from "effect/Path";
import {
  ProviderInstanceId,
  AgentDefinitionError,
  ResolvedAgentDefinition,
  type AgentDefinition,
} from "@t3tools/contracts";
import { discoverAgent } from "@t3tools/eve/discover";
import { loadAgentConfiguration } from "@t3tools/eve/load-module";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const AgentConfiguration = Schema.Struct({
  model: Schema.String.check(Schema.isPattern(/^(?:openai|anthropic)\/[^\s/]+$/)),
  description: Schema.optional(Schema.String),
});
const decodeConfiguration = Schema.decodeUnknownEffect(AgentConfiguration, {
  onExcessProperty: "error",
});
const decodeDefinition = Schema.decodeUnknownEffect(ResolvedAgentDefinition);
const isAgentDefinitionError = Schema.is(AgentDefinitionError);

/** Translates Eve's source definition into the subset supported by T3's harnesses. */
export const loadAgentDefinition = Effect.fn("loadAgentDefinition")(
  function* (workspaceRoot: string, definition: AgentDefinition) {
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
    const instructions = parts
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .trim();
    if (instructions.length === 0) {
      return yield* new AgentDefinitionError({
        path: manifest.agentRoot,
        message: "Agent has no Markdown instructions.",
      });
    }
    const skills: string[] = [];
    for (const skill of manifest.skills) {
      if (skill.sourceKind !== "markdown" && skill.sourceKind !== "directory") {
        return yield* new AgentDefinitionError({
          path: path.join(manifest.agentRoot, skill.logicalPath),
          message:
            "Agent skills must be Markdown files or directories named for a native harness skill.",
        });
      }
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
      instructions,
      skills,
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
