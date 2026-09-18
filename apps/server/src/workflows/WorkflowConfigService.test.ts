import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig, layerTest as serverConfigLayerTest } from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { WorkflowConfigService, layer } from "./WorkflowConfigService.ts";

const projectRepositoryLayer = Layer.succeed(ProjectionProjectRepository, {
  upsert: () => Effect.void,
  getById: ({ projectId }) =>
    Effect.succeed(
      Option.some({
        projectId,
        title: "Test project",
        workspaceRoot: projectId,
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        scripts: [],
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        deletedAt: null,
      }),
    ),
  listAll: () => Effect.succeed([]),
  deleteById: () => Effect.void,
});

const testLayer = layer.pipe(
  Layer.provideMerge(projectRepositoryLayer),
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(Layer.fresh(serverConfigLayerTest(process.cwd(), { prefix: "t3-workflow-" }))),
  Layer.provideMerge(NodeServices.layer),
);

function writeYaml(filePath: string, contents: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  });
}

function writeAgent(
  workspaceRoot: string,
  name: string,
  instructions: string,
  model = "openai/gpt-5.4",
) {
  return Effect.all(
    [
      writeYaml(`${workspaceRoot}/.t3/agents/${name}/instructions.md`, instructions),
      writeYaml(
        `${workspaceRoot}/.t3/agents/${name}/agent.ts`,
        `export default { model: ${JSON.stringify(model)} };`,
      ),
    ],
    { discard: true },
  );
}

it.layer(testLayer)("WorkflowConfigService", (it) => {
  it.effect(
    "includes attached skill instructions for every role without sharing them between agents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const workflows = yield* WorkflowConfigService;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
        for (const name of ["planner", "implementer", "reviewer"]) {
          yield* writeAgent(workspaceRoot, name, `${name} instructions.`);
          yield* writeYaml(
            `${workspaceRoot}/.t3/agents/${name}/skills/specialty/SKILL.md`,
            `${name} skill content.`,
          );
        }
        yield* writeYaml(
          `${config.stateDir}/workflows/profiles/attached.yaml`,
          "version: 1\nid: attached\nname: Attached\nplanner: planner\nimplementer: implementer\nreviewers: [reviewer]\nchecks:\n  - id: test\n    name: Test\n    run: test-command\nlimits:\n  maxRevisionCycles: 3\n  identicalFailureLimit: 2\n",
        );
        const { profile } = yield* workflows.resolveProfile({
          projectId: ProjectId.make(workspaceRoot),
          profileId: "attached",
        });
        for (const agent of [profile.planner, profile.implementer, ...profile.reviewers]) {
          assert.include(agent.instructions, `${agent.name} skill content.`);
          assert.deepEqual(agent.skills, []);
          for (const other of ["planner", "implementer", "reviewer"].filter(
            (name) => name !== agent.name,
          ))
            assert.notInclude(agent.instructions, `${other} skill content.`);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("resolves a YAML profile from Eve-style project agent folders", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const globalRoot = path.join(config.stateDir, "workflows");

      yield* Effect.all(
        [
          writeAgent(workspaceRoot, "planner", "Clarify the request."),
          writeAgent(workspaceRoot, "implementer", "Implement the plan."),
          writeAgent(
            workspaceRoot,
            "reviewer",
            "Review repository conventions.",
            "anthropic/claude-sonnet-4-6",
          ),
          writeYaml(
            path.join(workspaceRoot, ".t3", "agents", "reviewer", "skills", "code-review.md"),
            "The provider harness owns this skill's execution.",
          ),
          writeYaml(
            path.join(globalRoot, "profiles", "default.yaml"),
            "version: 1\nid: default\nname: Default\nplanner: planner\nimplementer: implementer\nreviewers: [reviewer]\nchecks:\n  - id: test\n    name: Tests\n    run: vp test run focused.test.ts\nlimits:\n  maxRevisionCycles: 3\n  identicalFailureLimit: 2\n",
          ),
        ],
        { concurrency: "unbounded", discard: true },
      );

      const resolved = yield* workflows.resolveProfile({
        projectId: ProjectId.make(workspaceRoot),
        profileId: "default",
      });

      assert.equal(resolved.workspaceRoot, workspaceRoot);
      assert.equal(resolved.profile.planner.instructions, "Clarify the request.");
      assert.deepEqual(resolved.profile.planner.modelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
      assert.equal(resolved.profile.reviewers[0]?.id, ".t3/agents/reviewer");
      assert.equal(resolved.profile.implementer.instructions, "Implement the plan.");
      assert.equal(resolved.profile.reviewers[0]?.name, "reviewer");
      assert.deepEqual(resolved.profile.reviewers[0]?.skills, ["code-review"]);
      assert.deepEqual(resolved.profile.reviewers[0]?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      });
      assert.equal(resolved.profile.checks[0]?.timeoutMs, 600_000);
      assert.equal(resolved.profile.limits.maxRevisionCycles, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects authored Eve tools instead of bypassing the provider harness", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const root = path.join(config.stateDir, "workflows");

      yield* Effect.all(
        [
          writeAgent(workspaceRoot, "planner", "Plan."),
          writeAgent(workspaceRoot, "implementer", "Implement."),
          writeAgent(workspaceRoot, "reviewer", "Review."),
          writeYaml(
            path.join(workspaceRoot, ".t3", "agents", "reviewer", "tools", "inspect.ts"),
            "export default {};",
          ),
          writeYaml(
            path.join(root, "profiles", "invalid-selection.yaml"),
            "version: 1\nid: invalid-selection\nname: Invalid selection\nplanner: planner\nimplementer: implementer\nreviewers: [reviewer]\nchecks:\n  - id: test\n    name: Tests\n    run: test-command\nlimits:\n  maxRevisionCycles: 3\n  identicalFailureLimit: 2\n",
          ),
        ],
        { discard: true },
      );

      const result = yield* Effect.result(
        workflows.resolveProfile({
          projectId: ProjectId.make(workspaceRoot),
          profileId: "invalid-selection",
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(result.failure.detail, /cannot run through the T3 provider harness/);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects skill assignments on non-reviewer agents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const root = path.join((yield* ServerConfig).stateDir, "workflows");

      yield* Effect.all(
        [
          writeAgent(workspaceRoot, "planner", "Plan."),
          writeAgent(workspaceRoot, "implementer", "Implement."),
          writeAgent(workspaceRoot, "reviewer", "Review."),
          writeYaml(
            path.join(workspaceRoot, ".t3", "agents", "planner", "skills", "product-planning.md"),
            "Plan products.",
          ),
          writeYaml(
            path.join(root, "profiles", "invalid-skills.yaml"),
            "version: 1\nid: invalid-skills\nname: Invalid skills\nplanner: planner\nimplementer: implementer\nreviewers: [reviewer]\nchecks:\n  - id: test\n    name: Tests\n    run: test-command\nlimits:\n  maxRevisionCycles: 3\n  identicalFailureLimit: 2\n",
          ),
        ],
        { discard: true },
      );

      const result = yield* Effect.result(
        workflows.resolveProfile({
          projectId: ProjectId.make(workspaceRoot),
          profileId: "invalid-skills",
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(result.failure.detail, /only reviewers support skill allowlists/);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects duplicate reviewer ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const root = path.join((yield* ServerConfig).stateDir, "workflows");

      yield* Effect.all(
        ["planner", "implementer", "reviewer"].map((name) =>
          writeAgent(workspaceRoot, name, "Do the job."),
        ),
        { discard: true },
      );
      yield* writeYaml(
        path.join(root, "profiles", "duplicate.yaml"),
        "version: 1\nid: duplicate\nname: Duplicate\nplanner: planner\nimplementer: implementer\nreviewers: [reviewer, .t3/agents/reviewer]\nchecks:\n  - id: test\n    name: Tests\n    run: test-command\nlimits:\n  maxRevisionCycles: 3\n  identicalFailureLimit: 2\n",
      );

      const result = yield* Effect.result(
        workflows.resolveProfile({
          projectId: ProjectId.make(workspaceRoot),
          profileId: "duplicate",
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(result.failure.detail, /unique/);
      }
    }).pipe(Effect.scoped),
  );
});

it.layer(Layer.fresh(testLayer))("workflow profile discovery", (it) => {
  it.effect("lists project profiles with repository overrides and no default requirement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-profiles-" });
      const otherRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-profiles-" });
      const input = { projectId: ProjectId.make(workspaceRoot) };
      assert.deepEqual(yield* workflows.listProfiles(input), []);

      yield* fs.writeFileString(
        path.join(workspaceRoot, "t3.json"),
        '{ "workflowsDirectory": "config/workflows" }',
      );
      const globalProfiles = path.join(config.stateDir, "workflows", "profiles");
      const repositoryProfiles = path.join(workspaceRoot, "config", "workflows", "profiles");
      const definition = (id: string, name: string) =>
        JSON.stringify({
          version: 1,
          id,
          name,
          planner: "planner",
          implementer: "implementer",
          reviewers: ["reviewer"],
          checks: [{ id: "test", name: "Tests", run: "test-command" }],
          limits: { maxRevisionCycles: 3, identicalFailureLimit: 2 },
        });
      yield* writeYaml(path.join(globalProfiles, "shared.json"), definition("shared", "Global"));
      yield* writeYaml(path.join(globalProfiles, "quick.yml"), definition("quick", "Quick"));
      yield* writeYaml(
        path.join(repositoryProfiles, "shared.yaml"),
        definition("shared", "Repository"),
      );
      yield* writeYaml(
        path.join(repositoryProfiles, "custom.json"),
        definition("custom", "Custom"),
      );
      yield* writeYaml(path.join(repositoryProfiles, "ignored.txt"), "not a workflow");

      assert.deepEqual(yield* workflows.listProfiles(input), [
        { id: "custom", name: "Custom" },
        { id: "quick", name: "Quick" },
        { id: "shared", name: "Repository" },
      ]);
      assert.deepEqual(yield* workflows.listProfiles({ projectId: ProjectId.make(otherRoot) }), [
        { id: "shared", name: "Global" },
        { id: "quick", name: "Quick" },
      ]);

      for (const role of ["planner", "implementer", "reviewer"]) {
        yield* writeAgent(workspaceRoot, role, "Do the job.");
      }
      const resolved = yield* workflows.resolveProfile({ ...input, profileId: "shared" });
      assert.equal(resolved.profile.name, "Repository");

      yield* writeYaml(path.join(repositoryProfiles, "broken.yaml"), "version: 1");
      const result = yield* Effect.result(workflows.listProfiles(input));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.path, path.join(repositoryProfiles, "broken.yaml"));
      }
    }).pipe(Effect.scoped),
  );
});
