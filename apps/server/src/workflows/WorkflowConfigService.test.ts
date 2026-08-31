import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
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

it.layer(testLayer)("WorkflowConfigService", (it) => {
  it.effect("resolves a profile and applies repository agent overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const globalRoot = path.join(config.stateDir, "workflows");
      const repositoryWorkflowsRoot = path.join(workspaceRoot, "config", "workflows");

      yield* Effect.all(
        [
          writeYaml(
            path.join(globalRoot, "agents", "planner.yaml"),
            "version: 1\nid: planner\nname: Planner\nrole: planner\nproviderInstanceId: claude-work\nmodel: claude-opus-4-1\ninstructions: Clarify the request.\n",
          ),
          writeYaml(
            path.join(globalRoot, "agents", "implementer.yaml"),
            "version: 1\nid: implementer\nname: Implementer\nrole: implementer\ninstructions: Implement the plan.\n",
          ),
          writeYaml(
            path.join(globalRoot, "agents", "reviewer.yaml"),
            "version: 1\nid: reviewer\nname: Reviewer\nrole: reviewer\ninstructions: Global review.\n",
          ),
          writeYaml(
            path.join(repositoryWorkflowsRoot, "agents", "reviewer.yaml"),
            "version: 1\nid: reviewer\nname: Repository reviewer\nrole: reviewer\nproviderInstanceId: codex-review\nmodel: gpt-5.6-sol\nskills: [code-review]\ninstructions: Review repository conventions.\n",
          ),
          fs.writeFileString(
            path.join(workspaceRoot, "t3.json"),
            '{ "workflowsDirectory": "config/workflows" }',
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
      assert.equal(resolved.profile.reviewers[0]?.name, "Repository reviewer");
      assert.equal(resolved.profile.planner.providerInstanceId, "claude-work");
      assert.equal(resolved.profile.planner.model, "claude-opus-4-1");
      assert.equal(resolved.profile.implementer.providerInstanceId, undefined);
      assert.equal(resolved.profile.implementer.model, undefined);
      assert.equal(resolved.profile.reviewers[0]?.providerInstanceId, "codex-review");
      assert.equal(resolved.profile.reviewers[0]?.model, "gpt-5.6-sol");
      assert.deepEqual(resolved.profile.reviewers[0]?.skills, ["code-review"]);
      assert.equal(resolved.profile.checks[0]?.timeoutMs, 600_000);
      assert.equal(resolved.profile.limits.maxRevisionCycles, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("requires an agent to select a provider instance and model together", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const root = path.join(config.stateDir, "workflows");

      yield* Effect.all(
        [
          writeYaml(
            path.join(root, "agents", "planner.yaml"),
            "version: 1\nid: planner\nname: Planner\nrole: planner\nproviderInstanceId: codex\ninstructions: Plan.\n",
          ),
          writeYaml(
            path.join(root, "agents", "implementer.yaml"),
            "version: 1\nid: implementer\nname: Implementer\nrole: implementer\ninstructions: Implement.\n",
          ),
          writeYaml(
            path.join(root, "agents", "reviewer.yaml"),
            "version: 1\nid: reviewer\nname: Reviewer\nrole: reviewer\ninstructions: Review.\n",
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
        assert.match(result.failure.detail, /must set both providerInstanceId and model/);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects skill assignments on non-reviewer agents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const root = path.join(config.stateDir, "workflows");

      yield* Effect.all(
        [
          writeYaml(
            path.join(root, "agents", "planner.yaml"),
            "version: 1\nid: planner\nname: Planner\nrole: planner\nskills: [product-planning]\ninstructions: Plan.\n",
          ),
          writeYaml(
            path.join(root, "agents", "implementer.yaml"),
            "version: 1\nid: implementer\nname: Implementer\nrole: implementer\ninstructions: Implement.\n",
          ),
          writeYaml(
            path.join(root, "agents", "reviewer.yaml"),
            "version: 1\nid: reviewer\nname: Reviewer\nrole: reviewer\nskills: [code-review]\ninstructions: Review.\n",
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
      const config = yield* ServerConfig;
      const workflows = yield* WorkflowConfigService;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-" });
      const root = path.join(config.stateDir, "workflows");

      yield* Effect.all(
        [
          ["planner", "planner"],
          ["implementer", "implementer"],
          ["reviewer", "reviewer"],
        ].map(([id, role]) =>
          writeYaml(
            path.join(root, "agents", `${id}.yaml`),
            `version: 1\nid: ${id}\nname: ${id}\nrole: ${role}\ninstructions: Do the job.\n`,
          ),
        ),
        { discard: true },
      );
      yield* writeYaml(
        path.join(root, "profiles", "duplicate.yaml"),
        "version: 1\nid: duplicate\nname: Duplicate\nplanner: planner\nimplementer: implementer\nreviewers: [reviewer, reviewer]\nchecks:\n  - id: test\n    name: Tests\n    run: test-command\nlimits:\n  maxRevisionCycles: 3\n  identicalFailureLimit: 2\n",
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
