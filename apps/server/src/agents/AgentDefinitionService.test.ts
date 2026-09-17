import { AgentDefinitionService, layer } from "./AgentDefinitionService.ts";
import { ProjectId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAgentDefinitions } from "./AgentDefinitionService.ts";

const fixture = Effect.fn("fixture")(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-definitions-" });
  for (const [file, contents] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
    yield* fs.writeFileString(path.join(root, file), contents);
  }
  return root;
});

it.layer(NodeServices.layer)("agent definitions", (it) => {
  it.effect(
    "discovers nested agents with their own instructions and capabilities without executing modules",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture({
          "agent/instructions.md": "Coordinate work.",
          "agent/tools/search.ts": "throw new Error('must not execute');",
          "agent/subagents/google/agent.ts": "throw new Error('must not execute');",
          "agent/subagents/google/instructions.md": "Manage Google services.",
          "agent/subagents/google/connections/google.ts": "export default {};",
          "agent/subagents/google/subagents/gmail/agent.ts": "export default {};",
          "agent/subagents/reviewer/agent.ts": "export default {};",
          "agent/subagents/reviewer/skills/review.md": "Review changes.",
        });
        const definitions = yield* discoverAgentDefinitions(root);
        expect(definitions.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
          { id: "agent", parentId: null },
          { id: "agent/subagents/google", parentId: "agent" },
          { id: "agent/subagents/google/subagents/gmail", parentId: "agent/subagents/google" },
          { id: "agent/subagents/reviewer", parentId: "agent" },
        ]);
        expect(definitions[1]?.slots).toEqual(["connections", "subagents"]);
        expect(definitions[1]?.instructionPaths).toEqual([
          "agent/subagents/google/instructions.md",
        ]);
        expect(definitions[2]?.instructionPaths).toEqual([]);
        expect(definitions[2]?.slots).toEqual([]);
        expect(definitions[3]?.slots).toEqual(["skills"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "discovers both workspace member layouts and excludes separate packages and unrelated folders",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture({
          "agents/google/agent/instructions.md": "Google.",
          "agents/reviewer/instructions.ts": "export default 'Review';",
          "agents/separate/package.json": "{}",
          "agents/separate/agent/instructions.md": "Separate project.",
          "agents/unrelated/README.md": "Not an agent.",
        });
        const definitions = yield* discoverAgentDefinitions(root);
        expect(definitions.map(({ name, directory }) => ({ name, directory }))).toEqual([
          { name: "google", directory: "agents/google/agent" },
          { name: "reviewer", directory: "agents/reviewer" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("gives a single root agent precedence over workspace members", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "agent/instructions.md": "Root.",
        "agents/other/agent/instructions.md": "Other.",
      });
      expect((yield* discoverAgentDefinitions(root)).map(({ id }) => id)).toEqual(["agent"]);
    }).pipe(Effect.scoped),
  );

  it.effect("supports flat roots and directory-based instructions", () =>
    Effect.gen(function* () {
      const root = yield* fixture({ "instructions/identity.md": "Root.", "tools/search.ts": "" });
      const definitions = yield* discoverAgentDefinitions(root);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        id: ".",
        parentId: null,
        instructionPaths: ["instructions"],
        slots: ["tools"],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("does not follow symbolic links into another agent or a recursive parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fixture({ "agent/instructions.md": "Root." });
      yield* fs.makeDirectory(path.join(root, "agent/subagents"));
      yield* fs.symlink(path.join(root, "agent"), path.join(root, "agent/subagents/loop"));
      expect(yield* discoverAgentDefinitions(root)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("returns an empty catalog for ordinary projects", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "AGENTS.md": "Project instructions are not an agent definition.",
      });
      expect(yield* discoverAgentDefinitions(root)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reflects edited folders on the next request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fixture({ "agent/instructions.md": "Root." });
      expect(yield* discoverAgentDefinitions(root)).toHaveLength(1);
      yield* fs.makeDirectory(path.join(root, "agent/subagents/new"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "agent/subagents/new/agent.ts"),
        "export default {};",
      );
      expect(yield* discoverAgentDefinitions(root)).toHaveLength(2);
      yield* fs.remove(path.join(root, "agent/subagents/new"), { recursive: true });
      expect(yield* discoverAgentDefinitions(root)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

const serviceLayer = layer.pipe(
  Layer.provide(
    Layer.mock(ProjectionProjectRepository)({
      getById: ({ projectId }) =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Test",
            workspaceRoot: projectId,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(serviceLayer)("project agent catalog", (it) => {
  it.effect("lists agents from the registered project's workspace", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const projectId = ProjectId.make(
        yield* fixture({ "agent/agent.ts": "throw new Error('must not execute');" }),
      );
      expect((yield* service.list({ projectId })).map(({ id }) => id)).toEqual(["agent"]);
    }).pipe(Effect.scoped),
  );
});
