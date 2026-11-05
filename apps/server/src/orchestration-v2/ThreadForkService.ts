import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { retainAgentSkill } from "../agents/AgentConversationResources.ts";
import {
  ContextTransferId,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ThreadForkPlanV2 {
  readonly targetThread: OrchestrationV2AppThread;
  readonly transfer: OrchestrationV2ContextTransfer;
}

export class ThreadForkPlanError extends Schema.TaggedError<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** waiting means provider-finished with checkpoint capture pending. */
export function isForkableSourceRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "waiting" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

export function forkableSourceRunStatusError(
  run: Pick<OrchestrationV2Run, "id" | "status">,
): string {
  return `Fork source run ${run.id} is ${run.status}; in-progress and rolled-back runs cannot be forked.`;
}

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly sourceProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
    /** Null only for a side chat whose parent has no stable run yet. */
    readonly sourceRun: OrchestrationV2Run | null;
    readonly sourceProviderThread: OrchestrationV2ProviderThread | undefined;
    readonly sourceTokenUsage?: OrchestrationV2ProviderTurnTokenUsage | undefined;
    readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
    readonly transferId: ContextTransferId;
    readonly targetThreadId: ThreadId;
    readonly title?: string;
    readonly sideChat?: boolean;
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkPlanError>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3/orchestration-v2/ThreadForkService/ThreadForkServiceV2") {}

export const layer: Layer.Layer<ThreadForkServiceV2, never, FileSystem.FileSystem | Path.Path> =
  Layer.effect(
    ThreadForkServiceV2,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // An agent conversation's fork gets its own copy of the agent's folder, so the two never share files.
      const copyAgent = Effect.fn("ThreadForkService.copyAgent")(function* (
        sourceAgent: NonNullable<OrchestrationV2AppThread["agent"]>,
      ) {
        const directory = yield* fs.makeTempDirectory({
          directory: path.dirname(sourceAgent.directory),
          prefix: "conversation-",
        });
        yield* retainAgentSkill(sourceAgent.directory, directory).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)),
        );
        return {
          ...sourceAgent,
          directory,
          definition: {
            ...sourceAgent.definition,
            instructions: sourceAgent.definition.instructions.replaceAll(
              sourceAgent.directory,
              directory,
            ),
          },
        };
      });
      return ThreadForkServiceV2.of({
        plan: Effect.fn("ThreadForkService.plan")(function* (input) {
          const { sourceRun } = input;
          const sourceLineage = input.sourceProjection.thread.lineage;
          // A task a linked environment delegated here is a subagent of a remote thread.
          if (
            input.sideChat &&
            (sourceLineage.sideChat ||
              sourceLineage.relationshipToParent === "subagent" ||
              input.sourceProjection.thread.delegatedFrom !== undefined)
          ) {
            return yield* new ThreadForkPlanError({
              sourceThreadId: input.sourceProjection.thread.id,
              targetThreadId: input.targetThreadId,
              cause: sourceLineage.sideChat
                ? "A side chat cannot start another side chat."
                : "A subagent cannot start a side chat.",
            });
          }
          if (sourceRun !== null && !isForkableSourceRunStatus(sourceRun.status)) {
            return yield* new ThreadForkPlanError({
              sourceThreadId: input.sourceProjection.thread.id,
              targetThreadId: input.targetThreadId,
              cause: forkableSourceRunStatusError(sourceRun),
            });
          }
          const sourceAgent = input.sourceProjection.thread.agent;
          const agent =
            sourceAgent === undefined
              ? undefined
              : yield* copyAgent(sourceAgent).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ThreadForkPlanError({
                        sourceThreadId: input.sourceProjection.thread.id,
                        targetThreadId: input.targetThreadId,
                        cause,
                      }),
                  ),
                );
          // The remote parent delegated the source thread, not its forks.
          const { delegatedFrom: _delegatedFrom, ...inherited } = input.sourceProjection.thread;
          const targetThread: OrchestrationV2AppThread = {
            ...inherited,
            ...(agent === undefined ? {} : { agent }),
            // PR context follows the conversation; watching remains the source thread's responsibility.
            pullRequests: input.sourceProjection.thread.pullRequests?.map(
              ({ watch: _watch, ...link }) => link,
            ),
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            id: input.targetThreadId,
            title: input.title ?? `${input.sourceProjection.thread.title} fork`,
            // The source's title job completes only on the source thread.
            titleRegeneration: null,
            // Side chats share the parent's worktree, so they start supervised.
            ...(input.sideChat ? { runtimeMode: "approval-required" as const } : {}),
            activeProviderThreadId: null,
            // A fork is an ordinary exploratory thread unless a workflow is
            // explicitly created for it. Reviewer forks must never recursively
            // run the source workflow.
            workflow: null,
            lineage: {
              parentThreadId: input.sourceProjection.thread.id,
              relationshipToParent: "fork",
              rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
              ...(input.sideChat ? { sideChat: true } : {}),
            },
            forkedFrom:
              sourceRun === null
                ? null
                : { type: "run", threadId: input.sourceProjection.thread.id, runId: sourceRun.id },
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            lastSnoozeWakeAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            autoSettleDisabledAt: null,
            // A guest link belongs to the thread it was made for.
            guestShare: null,
            lastVisitedAt: null,
            // A fork is a new thread; it does not inherit how often the source was opened.
            opens: null,
            deletedAt: null,
          };
          const transfer: OrchestrationV2ContextTransfer = {
            id: input.transferId,
            type: "fork",
            sourceThreadId: input.sourceProjection.thread.id,
            targetThreadId: input.targetThreadId,
            sourcePoint: input.canonicalSourcePoint,
            basePoint: null,
            sourceProviderInstanceId:
              sourceRun?.providerInstanceId ?? input.sourceProjection.thread.providerInstanceId,
            // Only native forks retain this context; portable handoffs rebuild it.
            sourceTokenUsage:
              (sourceRun?.status === "completed" || sourceRun?.status === "waiting") &&
              input.sourceProviderThread?.nativeThreadRef?.strength === "strong"
                ? input.sourceTokenUsage
                : undefined,
            targetProviderInstanceId: null,
            targetRunId: null,
            status: "pending",
            resolution: null,
            createdBy: input.createdBy,
            error:
              input.sourceProviderThread?.nativeThreadRef?.strength === "strong"
                ? null
                : "Source provider thread does not expose a strong native thread ref.",
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            consumedAt: null,
          };
          return { targetThread, transfer };
        }),
      });
    }),
  );
