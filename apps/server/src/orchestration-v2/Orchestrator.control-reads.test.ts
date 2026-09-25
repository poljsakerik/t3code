import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PlanArtifact,
  type ThreadWorkflowState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorDispatchError, OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const projections = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                decision: "accept",
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(testLayer)),
);

for (const scenario of [
  { name: "same thread" },
  { name: "new thread", newThread: true },
  { name: "verified workflow", workflow: true, status: "completed" },
  { name: "missing plan", missing: true, rejection: "does not exist" },
  { name: "todo list", todoList: true, rejection: "does not exist" },
  { name: "superseded plan", status: "superseded", rejection: "cannot be implemented" },
  {
    name: "different project",
    newThread: true,
    differentProject: true,
    rejection: "different project",
  },
] as const) {
  const options: {
    newThread?: boolean;
    workflow?: boolean;
    status?: OrchestrationV2PlanArtifact["status"];
    missing?: boolean;
    todoList?: boolean;
    differentProject?: boolean;
    rejection?: string;
  } = scenario;
  it.effect(
    `resolves the selected implementation plan without hydrating history (${scenario.name})`,
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const projections = yield* ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const sourceThreadId = ThreadId.make("thread:plan-source");
        const targetThreadId = options.newThread
          ? ThreadId.make("thread:plan-target")
          : sourceThreadId;
        const planId = PlanId.make("plan:selected");
        for (const threadId of new Set([sourceThreadId, targetThreadId])) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${threadId}`),
            threadId,
            projectId: ProjectId.make(
              options.differentProject && threadId === targetThreadId
                ? "other-project"
                : "plan-project",
            ),
            title: "Implement a plan",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        }
        const implementerSelection = { ...modelSelection, model: "workflow-implementer" };
        if (options.workflow) {
          const thread = yield* projections.getThread(sourceThreadId);
          const agent = {
            id: "agent",
            name: "Agent",
            skills: [],
            instructions: "Follow the plan.",
          };
          const workflow: ThreadWorkflowState = {
            profileId: "verified",
            workspaceRoot: "/workspace",
            profile: {
              version: 1,
              id: "verified",
              name: "Verified",
              planner: { ...agent, modelSelection },
              implementer: { ...agent, modelSelection: implementerSelection },
              reviewers: [agent],
              checks: [{ id: "check", name: "Check", run: "true", timeoutMs: 1000 }],
              limits: { maxRevisionCycles: 3, identicalFailureLimit: 2 },
            },
            status: "planned",
            revision: 0,
            revisionCycles: 0,
            consecutiveFailureCount: 0,
            lastFailureFingerprint: null,
            approvedPlanId: null,
            candidateRunId: null,
            workspaceDigest: null,
            checks: [],
            reviews: [],
            terminalReason: null,
            updatedAt: DateTime.formatIso(now),
          };
          yield* projections.apply({
            id: EventId.make("seed-workflow"),
            type: "thread.workflow-updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: { ...thread, workflow },
          });
        }
        if (!options.missing) {
          yield* projections.apply({
            id: EventId.make("seed-plan"),
            type: "plan.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: planId,
              threadId: sourceThreadId,
              runId: null,
              nodeId: NodeId.make("node:plan"),
              status: options.status ?? "active",
              ...(options.todoList
                ? { kind: "todo_list", steps: [] }
                : { kind: "proposed_plan", markdown: "Fix the regression." }),
            },
          });
        }
        // Unrelated historical payloads must not be decoded to implement this plan.
        yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${sourceThreadId}, NULL, 'old-node', 'proposed_plan', 'completed', '{"obsolete":true}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('obsolete-message', ${sourceThreadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        const dispatch = orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("implement-plan"),
          threadId: targetThreadId,
          messageId: MessageId.make("implementation-message"),
          text: "Implement the plan.",
          attachments: [],
          sourcePlanRef: { threadId: sourceThreadId, planId },
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        if (options.rejection !== undefined) {
          const error = yield* Effect.flip(dispatch);
          assert.instanceOf(error, OrchestratorDispatchError);
          assert.include(String(error.cause), options.rejection);
          assert.isEmpty((yield* projections.getThreadRecords(targetThreadId, ["runs"])).runs);
          return;
        }
        yield* dispatch;
        const records = yield* projections.getThreadRecords(targetThreadId, ["runs", "messages"], {
          messageRoles: ["user"],
        });
        assert.equal(records.runs.length, 1);
        assert.deepEqual(records.runs[0]?.sourcePlanRef, { threadId: sourceThreadId, planId });
        assert.equal((yield* projections.getPlan(sourceThreadId, planId))?.status, "completed");
        if (options.workflow) {
          assert.equal(records.thread.workflow?.status, "implementing");
          assert.equal(records.thread.workflow?.approvedPlanId, planId);
          assert.equal(records.thread.workflow?.revision, 1);
          assert.deepEqual(records.runs[0]?.modelSelection, implementerSelection);
          assert.include(records.messages[0]!.text, "Implement the approved plan completely.");
        }
      }).pipe(Effect.provide(testLayer)),
  );
}
