import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { layer, ThreadForkServiceV2 } from "./ThreadForkService.ts";

const sourceThreadId = ThreadId.make("thread:fork-snoozed-source");
const targetThreadId = ThreadId.make("thread:fork-awake-target");
const sourceRunId = RunId.make("run:fork-snoozed-source");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const sourceCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const forkCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeSourceThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: sourceThreadId,
    projectId: ProjectId.make("project:fork-snooze"),
    title: "Snoozed source",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: null,
    createdAt: sourceCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
  };
}

function makeCompletedSourceRun(): OrchestrationV2Run {
  return {
    id: sourceRunId,
    threadId: sourceThreadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: ProviderThreadId.make("provider-thread:fork-snoozed-source"),
    userMessageId: MessageId.make("message:fork-snoozed-source"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    queuePosition: null,
    requestedAt: sourceCreatedAt,
    startedAt: sourceCreatedAt,
    completedAt: snoozedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

it.effect("keeps a fork awake when its source thread is snoozed", () =>
  Effect.gen(function* () {
    const sourceThread = makeSourceThread();
    const sourceRun = makeCompletedSourceRun();
    const sourceProjection: OrchestrationV2ThreadProjection = {
      thread: sourceThread,
      runs: [sourceRun],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: snoozedAt,
    };
    const service = yield* ThreadForkServiceV2;
    const result = yield* service.plan({
      sourceProjection,
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: {
        threadId: sourceThreadId,
        runId: sourceRunId,
      },
      transferId: ContextTransferId.make("context-transfer:fork-snoozed-source"),
      targetThreadId,
      title: "Awake fork",
      createdBy: "user",
      creationSource: "mobile",
      createdAt: forkCreatedAt,
    });

    assert.isNull(result.targetThread.snoozedUntil);
    assert.isNull(result.targetThread.snoozedAt);
    assert.equal(result.targetThread.projectId, sourceThread.projectId);
    assert.equal(result.targetThread.providerInstanceId, sourceThread.providerInstanceId);
    assert.deepEqual(result.targetThread.modelSelection, sourceThread.modelSelection);
    assert.equal(result.targetThread.runtimeMode, sourceThread.runtimeMode);
    assert.equal(result.targetThread.interactionMode, sourceThread.interactionMode);
    assert.equal(result.targetThread.branch, sourceThread.branch);
    assert.equal(result.targetThread.worktreePath, sourceThread.worktreePath);
    assert.isNull(result.targetThread.activeProviderThreadId);
    assert.deepEqual(result.targetThread.lineage, {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
    });
    assert.deepEqual(result.targetThread.forkedFrom, {
      type: "run",
      threadId: sourceThreadId,
      runId: sourceRunId,
    });
  }).pipe(Effect.provide(layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("gives an agent fork independent files while retaining its saved setup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-fork-" });
    const sourceDirectory = yield* fs.realPath(root);
    const directory = path.join(sourceDirectory, "original");
    yield* fs.makeDirectory(path.join(directory, "skills/writer"), { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "skills/writer/reference.md"),
      "Original guidance",
    );
    const sourceThread = {
      ...makeSourceThread(),
      projectId: null,
      branch: null,
      worktreePath: null,
      agent: {
        owner: { agentId: ".t3/agents/writer", sourceProjectId: null, name: "Writer" },
        definition: {
          id: ".t3/agents/writer",
          name: "Writer",
          instructions: `Use ${directory}/skills/writer/reference.md`,
          skills: [],
          modelSelection,
        },
        directory,
      },
    };
    const sourceRun = makeCompletedSourceRun();
    const sourceProjection: OrchestrationV2ThreadProjection = {
      thread: sourceThread,
      runs: [sourceRun],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: snoozedAt,
    };
    const service = yield* ThreadForkServiceV2;
    const { targetThread } = yield* service.plan({
      sourceProjection,
      sourceRun,
      sourceProviderThread: undefined,
      canonicalSourcePoint: { threadId: sourceThreadId, runId: sourceRunId },
      transferId: ContextTransferId.make("agent-fork"),
      targetThreadId,
      createdBy: "user",
      creationSource: "web",
      createdAt: forkCreatedAt,
    });
    assert.deepEqual(targetThread.agent?.owner, sourceThread.agent.owner);
    assert.isNull(targetThread.projectId);
    assert.notEqual(targetThread.agent?.directory, directory);
    assert.notInclude(targetThread.agent!.definition.instructions, directory);
    const forkResource = path.join(targetThread.agent!.directory, "skills/writer/reference.md");
    assert.equal(yield* fs.readFileString(forkResource), "Original guidance");
    yield* fs.writeFileString(forkResource, "Fork guidance");
    assert.equal(
      yield* fs.readFileString(path.join(directory, "skills/writer/reference.md")),
      "Original guidance",
    );
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))), Effect.scoped),
);
