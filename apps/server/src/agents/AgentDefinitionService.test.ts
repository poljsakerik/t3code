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

import { discoverAgentDefinitions, resolveAgentDefinitions } from "./AgentDefinitionService.ts";

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
          ".t3/agent/instructions.md": "Coordinate work.",
          ".t3/agent/tools/search.ts": "throw new Error('must not execute');",
          ".t3/agent/subagents/google/agent.ts": "throw new Error('must not execute');",
          ".t3/agent/subagents/google/instructions.md": "Manage Google services.",
          ".t3/agent/subagents/google/connections/google.ts": "export default {};",
          ".t3/agent/subagents/google/subagents/gmail/agent.ts": "export default {};",
          ".t3/agent/subagents/reviewer/agent.ts": "export default {};",
          ".t3/agent/subagents/reviewer/skills/review.md": "Review changes.",
        });
        const definitions = yield* discoverAgentDefinitions(root);
        expect(definitions.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
          { id: ".t3/agent", parentId: null },
          { id: ".t3/agent/subagents/google", parentId: ".t3/agent" },
          {
            id: ".t3/agent/subagents/google/subagents/gmail",
            parentId: ".t3/agent/subagents/google",
          },
          { id: ".t3/agent/subagents/reviewer", parentId: ".t3/agent" },
        ]);
        expect(definitions[1]?.slots).toEqual(["connections", "subagents"]);
        expect(definitions[1]?.instructionPaths).toEqual([
          ".t3/agent/subagents/google/instructions.md",
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
          ".t3/agents/google/agent/instructions.md": "Google.",
          ".t3/agents/reviewer/instructions.ts": "export default 'Review';",
          ".t3/agents/separate/package.json": "{}",
          ".t3/agents/separate/agent/instructions.md": "Separate project.",
          ".t3/agents/unrelated/README.md": "Not an agent.",
        });
        const definitions = yield* discoverAgentDefinitions(root);
        expect(definitions.map(({ name, directory }) => ({ name, directory }))).toEqual([
          { name: "google", directory: ".t3/agents/google/agent" },
          { name: "reviewer", directory: ".t3/agents/reviewer" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("gives a single root agent precedence over workspace members", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        ".t3/agent/instructions.md": "Root.",
        ".t3/agents/other/agent/instructions.md": "Other.",
      });
      expect((yield* discoverAgentDefinitions(root)).map(({ id }) => id)).toEqual([".t3/agent"]);
    }).pipe(Effect.scoped),
  );

  it.effect("supports flat roots and directory-based instructions", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        ".t3/instructions/identity.md": "Root.",
        ".t3/tools/search.ts": "",
      });
      const definitions = yield* discoverAgentDefinitions(root);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        id: ".t3",
        parentId: null,
        instructionPaths: [".t3/instructions"],
        slots: ["tools"],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("does not follow symbolic links into another agent or a recursive parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fixture({ ".t3/agent/instructions.md": "Root." });
      yield* fs.makeDirectory(path.join(root, ".t3/agent/subagents"));
      yield* fs.symlink(path.join(root, ".t3/agent"), path.join(root, ".t3/agent/subagents/loop"));
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

  it.effect("resolves instructions and Eve skills before provider selection", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        ".t3/agents/design/agent.ts": "export default {};",
        ".t3/agents/design/instructions.md": "Review every changed surface.",
        ".t3/agents/design/skills/impeccable/SKILL.md":
          "---\nname: impeccable\ndescription: Review design.\n---\n",
      });
      const definitions = yield* resolveAgentDefinitions(root);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({
        id: ".t3/agents/design",
        instructions: "Review every changed surface.",
        skills: [
          {
            name: "impeccable",
            relativePath: ".t3/agents/design/skills/impeccable/SKILL.md",
          },
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("uses Eve module extensions and ignores YAML and folders outside .t3", () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        "agent/agent.ts": "Outside .t3",
        ".t3/agents/legacy.yaml": "version: 1",
        ".t3/workflows/agents/legacy.yaml": "version: 1",
        ".t3/agents/assistant/agent.mjs": "throw new Error('must not execute');",
        ".t3/agents/assistant/subagents/reviewer/instructions.mts":
          "throw new Error('must not execute');",
        ".t3/agents/declarations/agent.d.ts": "export interface Agent {}",
      });
      const definitions = yield* discoverAgentDefinitions(root);
      expect(definitions.map(({ id }) => id)).toEqual([
        ".t3/agents/assistant",
        ".t3/agents/assistant/subagents/reviewer",
      ]);
      expect(definitions[0]?.configurationPath).toBe(".t3/agents/assistant/agent.mjs");
      expect(definitions[1]?.instructionPaths).toEqual([
        ".t3/agents/assistant/subagents/reviewer/instructions.mts",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not follow a .t3 symlink outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fixture({});
      const outside = yield* fixture({ "agent/agent.ts": "export default {};" });
      yield* fs.symlink(outside, path.join(root, ".t3"));
      expect(yield* discoverAgentDefinitions(root)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("reflects edited folders on the next request", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fixture({ ".t3/agent/instructions.md": "Root." });
      expect(yield* discoverAgentDefinitions(root)).toHaveLength(1);
      yield* fs.makeDirectory(path.join(root, ".t3/agent/subagents/new"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".t3/agent/subagents/new/agent.ts"),
        "export default {};",
      );
      expect(yield* discoverAgentDefinitions(root)).toHaveLength(2);
      yield* fs.remove(path.join(root, ".t3/agent/subagents/new"), { recursive: true });
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
        yield* fixture({ ".t3/agent/agent.ts": "throw new Error('must not execute');" }),
      );
      expect((yield* service.list({ projectId })).map(({ id }) => id)).toEqual([".t3/agent"]);
    }).pipe(Effect.scoped),
  );
});
