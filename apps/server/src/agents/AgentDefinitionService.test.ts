import * as NodeOS from "node:os";
import { afterEach, vi } from "vite-plus/test";
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

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof NodeOS>();
  return { ...os, homedir: vi.fn(os.homedir) };
});

afterEach(() => vi.mocked(NodeOS.homedir).mockReset());

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
          projectId === "missing"
            ? Option.none()
            : Option.some({
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
      const result = yield* service.list({ projectId });
      expect(result.scope).toBe("project");
      expect(result.agents.map(({ id }) => id)).toEqual([".t3/agent"]);
    }).pipe(Effect.scoped),
  );

  it.effect("lists global agents without a registered home project", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const home = yield* fixture({
        ".t3/agents/assistant/instructions.md": "Global assistant.",
        ".t3/agents/assistant/subagents/reviewer/instructions.md": "Review work.",
      });
      vi.mocked(NodeOS.homedir).mockReturnValue(home);
      const result = yield* service.list({});
      expect(result.scope).toBe("global");
      expect(result.agents.map(({ id }) => id)).toEqual([
        ".t3/agents/assistant",
        ".t3/agents/assistant/subagents/reviewer",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("identifies a registered home project as global, including directory aliases", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fixture({ ".t3/agent/instructions.md": "Global assistant." });
      const workspace = yield* fixture({});
      const alias = path.join(workspace, "home");
      yield* fs.symlink(home, alias);
      vi.mocked(NodeOS.homedir).mockReturnValue(home);
      const global = yield* service.list({});
      expect(yield* service.list({ projectId: ProjectId.make(alias) })).toEqual(global);
      expect(global.scope).toBe("global");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps project agents separate from global agents", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const home = yield* fixture({ ".t3/agents/global/instructions.md": "Global." });
      const project = yield* fixture({ ".t3/agents/local/instructions.md": "Local." });
      vi.mocked(NodeOS.homedir).mockReturnValue(home);
      const result = yield* service.list({ projectId: ProjectId.make(project) });
      expect(result.scope).toBe("project");
      expect(result.agents.map(({ name }) => name)).toEqual(["local"]);
    }).pipe(Effect.scoped),
  );

  it.effect("returns an empty global group when the home directory has no agents", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      vi.mocked(NodeOS.homedir).mockReturnValue(yield* fixture({}));
      expect(yield* service.list({})).toEqual({ scope: "global", agents: [] });
    }).pipe(Effect.scoped),
  );

  it.effect("does not fall back to global agents for an unknown project", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const error = yield* service.list({ projectId: ProjectId.make("missing") }).pipe(Effect.flip);
      expect(error.message).toBe("Project missing was not found.");
    }),
  );
  it.effect("creates an instructions-only project agent and loads it for editing", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const root = yield* fixture({});
      const projectId = ProjectId.make(root);
      const agent = yield* service.create({
        projectId,
        name: "reviewer",
        instructions: "# Review\n\nFind bugs.\n",
      });
      expect(agent).toMatchObject({
        id: ".t3/agents/reviewer",
        name: "reviewer",
        configurationPath: null,
      });
      expect((yield* service.list({ projectId })).agents).toEqual([agent]);
      expect((yield* service.get({ projectId, agentId: agent.id })).documents).toEqual([
        { path: ".t3/agents/reviewer/instructions.md", content: "# Review\n\nFind bugs.\n" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("creates global agents in the environment home", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      vi.mocked(NodeOS.homedir).mockReturnValue(yield* fixture({}));
      const agent = yield* service.create({ name: "assistant", instructions: "Help out." });
      expect((yield* service.list({})).agents).toEqual([agent]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps new agents discoverable under a single root", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      for (const directory of [".t3", ".t3/agent"]) {
        const projectId = ProjectId.make(
          yield* fixture({ [`${directory}/instructions.md`]: "Root." }),
        );
        const agent = yield* service.create({
          projectId,
          name: "reviewer",
          instructions: "Review.",
        });
        expect(agent.parentId).toBe(directory);
        expect(agent.id).toBe(`${directory}/subagents/reviewer`);
        expect((yield* service.list({ projectId })).agents).toHaveLength(2);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects duplicate names, invalid names, and empty instructions without replacing files",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentDefinitionService;
        const projectId = ProjectId.make(
          yield* fixture({ ".t3/agents/reviewer/instructions.md": "Original." }),
        );
        for (const name of ["reviewer", "../outside", "a/b"]) {
          yield* service
            .create({ projectId, name, instructions: "Replacement." })
            .pipe(Effect.flip);
        }
        yield* service.create({ projectId, name: "empty", instructions: "  " }).pipe(Effect.flip);
        expect(
          (yield* service.get({ projectId, agentId: ".t3/agents/reviewer" })).documents[0]?.content,
        ).toBe("Original.");
        expect((yield* service.list({ projectId })).agents).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "edits named instructions while preserving configuration, skills, and other sources",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentDefinitionService;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fixture({
          ".t3/agent/agent.ts": "throw new Error('never execute');",
          ".t3/agent/instructions.md": "Root instructions.",
          ".t3/agent/instructions/review.md": "Review.",
          ".t3/agent/instructions/dynamic.ts": "throw new Error('never execute');",
          ".t3/agent/skills/review/SKILL.md": "Skill.",
        });
        const projectId = ProjectId.make(root);
        const input = { projectId, agentId: ".t3/agent" };
        const before = yield* service.get(input);
        expect(before.documents).toHaveLength(2);
        expect(before.otherInstructionPaths).toEqual([".t3/agent/instructions/dynamic.ts"]);
        yield* service.update({
          ...input,
          path: ".t3/agent/instructions/review.md",
          expectedContent: "Review.",
          content: "Review carefully.\n",
        });
        expect((yield* service.get(input)).documents).toContainEqual({
          path: ".t3/agent/instructions/review.md",
          content: "Review carefully.\n",
        });
        expect(yield* fs.readFileString(`${root}/.t3/agent/agent.ts`)).toBe(
          "throw new Error('never execute');",
        );
        expect(yield* fs.readFileString(`${root}/.t3/agent/instructions.md`)).toBe(
          "Root instructions.",
        );
        expect(yield* fs.readFileString(`${root}/.t3/agent/skills/review/SKILL.md`)).toBe("Skill.");
      }).pipe(Effect.scoped),
  );

  it.effect("rejects stale saves and paths outside the agent's instruction sources", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const projectId = ProjectId.make(
        yield* fixture({ ".t3/agent/instructions.md": "Original." }),
      );
      const input = {
        projectId,
        agentId: ".t3/agent",
        path: ".t3/agent/instructions.md",
        expectedContent: "Original.",
      };
      yield* service.update({ ...input, content: "Updated elsewhere." });
      const error = yield* service.update({ ...input, content: "Stale edit." }).pipe(Effect.flip);
      expect(error.message).toContain("changed since");
      yield* service
        .update({ ...input, path: "../outside.md", content: "Outside." })
        .pipe(Effect.flip);
      expect((yield* service.get(input)).documents[0]?.content).toBe("Updated elsewhere.");
    }).pipe(Effect.scoped),
  );

  it.effect("adds missing instructions and allows clearing existing instructions", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const projectId = ProjectId.make(
        yield* fixture({ ".t3/agent/agent.ts": "export default {};" }),
      );
      const input = { projectId, agentId: ".t3/agent", path: ".t3/agent/instructions.md" };
      expect((yield* service.get(input)).documents[0]?.content).toBeNull();
      yield* service.update({ ...input, expectedContent: null, content: "Added." });
      yield* service.update({ ...input, expectedContent: "Added.", content: "" });
      expect((yield* service.get(input)).documents[0]?.content).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "edits legacy system instructions and leaves executable-only instructions untouched",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentDefinitionService;
        const projectId = ProjectId.make(
          yield* fixture({
            ".t3/agents/legacy/system.md": "Legacy.",
            ".t3/agents/dynamic/instructions.ts": "throw new Error('never execute');",
          }),
        );
        expect((yield* service.get({ projectId, agentId: ".t3/agents/legacy" })).documents).toEqual(
          [{ path: ".t3/agents/legacy/system.md", content: "Legacy." }],
        );
        const dynamic = yield* service.get({ projectId, agentId: ".t3/agents/dynamic" });
        expect(dynamic.documents).toEqual([]);
        expect(dynamic.otherInstructionPaths).toEqual([".t3/agents/dynamic/instructions.ts"]);
      }).pipe(Effect.scoped),
  );

  it.effect("refuses writes through linked agent containers or instruction sources", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const fs = yield* FileSystem.FileSystem;
      const outside = yield* fixture({ "instructions.md": "Outside." });
      const root = yield* fixture({ ".t3/agent/agent.ts": "export default {};" });
      const projectId = ProjectId.make(root);
      yield* fs.symlink(outside, `${root}/.t3/agent/subagents`);
      yield* service
        .create({ projectId, name: "linked", instructions: "Do not write." })
        .pipe(Effect.flip);
      yield* fs.symlink(`${outside}/instructions.md`, `${root}/.t3/agent/instructions.md`);
      yield* service
        .update({
          projectId,
          agentId: ".t3/agent",
          path: ".t3/agent/instructions.md",
          expectedContent: null,
          content: "Do not write.",
        })
        .pipe(Effect.flip);
      expect(yield* fs.readFileString(`${outside}/instructions.md`)).toBe("Outside.");
      expect(yield* fs.exists(`${outside}/linked`)).toBe(false);
    }).pipe(Effect.scoped),
  );
  it.effect("creates discoverable agents when a single-agent folder is still empty", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fixture({});
      yield* fs.makeDirectory(`${root}/.t3/agent`, { recursive: true });
      const projectId = ProjectId.make(root);
      const created = yield* service.create({ projectId, name: "first", instructions: "Help." });
      expect(created.id).toBe(".t3/agent/subagents/first");
      expect((yield* service.list({ projectId })).agents).toContainEqual(created);
    }).pipe(Effect.scoped),
  );

  it.effect("serializes concurrent saves so only one editor can replace the loaded version", () =>
    Effect.gen(function* () {
      const service = yield* AgentDefinitionService;
      const projectId = ProjectId.make(
        yield* fixture({ ".t3/agent/instructions.md": "Original." }),
      );
      const input = {
        projectId,
        agentId: ".t3/agent",
        path: ".t3/agent/instructions.md",
        expectedContent: "Original.",
      };
      const results = yield* Effect.forEach(
        ["First edit.", "Second edit."],
        (content) => service.update({ ...input, content }).pipe(Effect.exit),
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result._tag).toSorted()).toEqual(["Failure", "Success"]);
      expect(["First edit.", "Second edit."]).toContain(
        (yield* service.get(input)).documents[0]?.content,
      );
    }).pipe(Effect.scoped),
  );
});
