import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAgentDefinitions } from "./AgentDefinitionService.ts";
import { loadAgentDefinition } from "./AgentDefinitionLoader.ts";

const fixture = Effect.fn("fixture")(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-loader-" });
  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(root, ".t3", "agents", "reviewer", name);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  }
  const definitions = yield* discoverAgentDefinitions(root);
  return { root, definition: definitions[0]! };
});

it.layer(NodeServices.layer)("AgentDefinitionLoader", (it) => {
  for (const [provider, instanceId, model] of [
    ["openai", "codex", "gpt-5.4"],
    ["anthropic", "claudeAgent", "claude-sonnet-4-6"],
  ] as const) {
    it.effect(`loads ${provider} configuration into a reusable harness definition`, () =>
      Effect.gen(function* () {
        const { root, definition } = yield* fixture({
          "agent.ts": `const model: string = "${provider}/${model}"; export default { model };`,
          "instructions.md": "Base instructions.",
          "instructions/02-review.md": "Review carefully.",
          "instructions/01-context.md": "Read the context.",
          "system.md": "Legacy instructions should not be included.",
          "skills/code-review.md": "Harness skill reference.",
          "subagents/other/instructions.md": "Other agent instructions should not be included.",
        });
        assert.deepEqual(yield* loadAgentDefinition(root, definition), {
          id: ".t3/agents/reviewer",
          name: "reviewer",
          instructions: "Base instructions.\n\nRead the context.\n\nReview carefully.",
          skills: ["code-review"],
          modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
        });
      }).pipe(Effect.scoped),
    );
  }

  it.effect("loads only the owning agent's packaged skills and freezes their instructions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, definition } = yield* fixture({
        "agent.ts": 'export default { model: "openai/gpt-5.4" };',
        "instructions.md": "Review.",
        "skills/impeccable/SKILL.md": "Use references/layout.md for design guidance.",
        "skills/impeccable/references/layout.md": "Reference.",
        "skills/impeccable/scripts/tool.ts": "throw new Error('must not execute');",
        "subagents/other/skills/private/SKILL.md": "Other agent's skill.",
      });
      const resolved = yield* loadAgentDefinition(root, definition);
      assert.deepEqual(resolved.skills, []);
      assert.include(resolved.instructions, "Use references/layout.md");
      assert.include(resolved.instructions, `${definition.directory}/skills/impeccable`);
      assert.notInclude(resolved.instructions, "Other agent's skill.");
      yield* fs.remove(`${root}/${definition.directory}/skills/impeccable`, { recursive: true });
      assert.equal((yield* loadAgentDefinition(root, definition)).instructions, "Review.");
      assert.include(resolved.instructions, "Use references/layout.md");
    }).pipe(Effect.scoped),
  );

  it.effect("reloads edited configuration while leaving a resolved snapshot unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, definition } = yield* fixture({
        "agent.ts": 'export default { model: "openai/gpt-5.4" };',
        "system.md": "Legacy instructions.",
      });
      const first = yield* loadAgentDefinition(root, definition);
      yield* fs.writeFileString(
        path.join(root, definition.directory, "agent.ts"),
        'export default { model: "anthropic/claude-sonnet-4-6" };',
      );
      const second = yield* loadAgentDefinition(root, definition);
      assert.equal(first.modelSelection.instanceId, "codex");
      assert.equal(second.modelSelection.instanceId, "claudeAgent");
      assert.equal(second.instructions, "Legacy instructions.");
    }).pipe(Effect.scoped),
  );

  for (const extension of ["mts", "mjs", "js", "cts", "cjs"]) {
    it.effect(`loads and refreshes agent.${extension}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exportPrefix =
          extension === "cts" || extension === "cjs" ? "module.exports =" : "export default";
        const { root, definition } = yield* fixture({
          [`agent.${extension}`]: `${exportPrefix} { model: "openai/gpt-5.4" };`,
          "instructions.md": "Review.",
        });
        assert.equal(
          (yield* loadAgentDefinition(root, definition)).modelSelection.instanceId,
          "codex",
        );
        yield* fs.writeFileString(
          path.join(root, definition.directory, `agent.${extension}`),
          `${exportPrefix} { model: "anthropic/claude-sonnet-4-6" };`,
        );
        assert.equal(
          (yield* loadAgentDefinition(root, definition)).modelSelection.instanceId,
          "claudeAgent",
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const [name, files, message] of [
    ["missing model", { "agent.ts": "export default {};" }, /configuration must declare/],
    [
      "unsupported provider",
      { "agent.ts": 'export default { model: "google/gemini" };' },
      /configuration must declare/,
    ],
    [
      "API model object",
      {
        "agent.ts":
          'export default { model: { provider: "anthropic", modelId: "claude", doGenerate() {} } };',
      },
      /configuration must declare/,
    ],
    [
      "runtime capabilities",
      { "agent.ts": 'export default { model: "openai/gpt-5.4", defaultTools: false };' },
      /configuration must declare/,
    ],
    ["missing config", { "agent.ts": "" }, /configuration must declare/],
    [
      "conflicting config",
      { "agent.mjs": 'export default { model: "openai/gpt-5.4" };' },
      /exactly one/,
    ],
    [
      "executable instructions",
      { "instructions.ts": "throw new Error('must not run');" },
      /Conflicting authored/,
    ],
    [
      "executable tools",
      { "tools/tool.ts": "throw new Error('must not run');" },
      /cannot run through/,
    ],
    [
      "executable skills",
      { "skills/skill.ts": "throw new Error('must not run');" },
      /native harness skill/,
    ],
    [
      "duplicate skills",
      { "skills/review.md": "Review.", "skills/review/SKILL.md": "Review." },
      /Could not load/,
    ],
  ] as const) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const { root, definition } = yield* fixture({
          "agent.ts": 'export default { model: "openai/gpt-5.4" };',
          "instructions.md": "Review.",
          ...files,
        });
        const result = yield* Effect.result(loadAgentDefinition(root, definition));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.match(result.failure.message, message);
      }).pipe(Effect.scoped),
    );
  }
});
