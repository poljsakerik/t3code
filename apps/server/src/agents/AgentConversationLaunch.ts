import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";
import { CommandId, AgentDefinitionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { CommandReceiptStoreV2 } from "../orchestration-v2/CommandReceiptStore.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import {
  ThreadLaunchError,
  type ThreadLaunchInput,
} from "../orchestration-v2/ThreadLaunchService.ts";
import { discoverAgentDefinitions } from "./AgentDefinitionService.ts";
import { loadAgentDefinition } from "./AgentDefinitionLoader.ts";
import { retainAgentSkill } from "./AgentConversationResources.ts";

const launchAgentConversation = Effect.fn("launchAgentConversation")(
  function* (input: Extract<ThreadLaunchInput, { agent: unknown }>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const projects = yield* ProjectionProjectRepository;
    const threads = yield* ThreadManagementService;
    const receipts = yield* CommandReceiptStoreV2;
    const ids = yield* IdAllocatorV2;
    const receipt = yield* receipts.getByCommandId(input.commandId);
    if (Option.isNone(receipt)) {
      const project =
        input.agent.sourceProjectId === null
          ? null
          : Option.getOrNull(yield* projects.getById({ projectId: input.agent.sourceProjectId }));
      if (
        input.agent.sourceProjectId !== null &&
        (project === null || project.deletedAt !== null)
      ) {
        return yield* new AgentDefinitionError({
          message: "The agent's source project is unavailable.",
        });
      }
      const sourceRoot = yield* fs.realPath(project?.workspaceRoot ?? NodeOS.homedir());
      const catalog = yield* discoverAgentDefinitions(sourceRoot);
      const definition = catalog.find((agent) => agent.id === input.agent.agentId);
      if (definition === undefined) {
        return yield* new AgentDefinitionError({
          message: "The selected agent definition is unavailable.",
        });
      }
      // A generated directory name prevents a client-provided thread id becoming a filesystem path.
      const isInsideSource = (directory: string) => {
        const relative = path.relative(sourceRoot, directory);
        return (
          relative === "" ||
          (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
        );
      };
      const stateRoot = path.join(config.stateDir, "agent-conversations");
      const root =
        project !== null && isInsideSource(stateRoot)
          ? path.join(NodeOS.homedir(), ".t3", "agent-conversations")
          : stateRoot;
      if (project !== null && isInsideSource(root)) {
        return yield* new AgentDefinitionError({
          message: "Agent conversations need a T3 data directory outside their source project.",
        });
      }
      yield* fs.makeDirectory(root, { recursive: true });
      const directory = yield* fs
        .makeTempDirectory({ directory: root, prefix: "conversation-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const prepared = yield* Effect.gen(function* () {
        const resolved = yield* loadAgentDefinition(sourceRoot, definition, {
          retainSkill: (source, name) =>
            retainAgentSkill(source, path.join(directory, "skills", name)).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            ),
        });
        return yield* threads.dispatch({
          type: "thread.create",
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: null,
          agent: {
            owner: { ...input.agent, name: resolved.name },
            definition: resolved,
            directory,
          },
          title: input.title,
          modelSelection: resolved.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
      }).pipe(Effect.onError(() => fs.remove(directory, { recursive: true }).pipe(Effect.ignore)));
      // Concurrent retries keep the directory belonging to the winning event.
      const created = prepared.storedEvents.find((event) => event.event.type === "thread.created");
      if (
        created?.event.type === "thread.created" &&
        created.event.payload.agent?.directory !== directory
      ) {
        yield* fs.remove(directory, { recursive: true });
      }
    }
    const projection = yield* threads.getThreadProjection(input.threadId);
    if (
      projection.thread.agent?.owner.agentId !== input.agent.agentId ||
      projection.thread.agent.owner.sourceProjectId !== input.agent.sourceProjectId
    ) {
      return yield* new AgentDefinitionError({
        message: "Conversation ownership does not match the selected agent.",
      });
    }
    if (input.initialMessage !== undefined) {
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:message`),
        threadId: input.threadId,
        messageId:
          input.initialMessage.messageId ??
          (yield* ids.allocate.message({ threadId: input.threadId, ordinal: 1 })),
        text: input.initialMessage.text,
        attachments: input.initialMessage.attachments,
        dispatchMode: { type: "start_immediately" },
        ...(input.initialMessage.context === undefined
          ? {}
          : { context: input.initialMessage.context }),
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
    }
    return {
      threadId: input.threadId,
      projection: yield* threads.getThreadProjection(input.threadId),
      resumed: Option.isSome(receipt),
    };
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ThreadLaunchError({
            operation: "create-thread",
            commandId: input.commandId,
            projectId: null,
            threadId: input.threadId,
            cause,
          }),
      ),
    ),
);

export class AgentConversationLauncher extends Context.Service<
  AgentConversationLauncher,
  {
    readonly launch: (
      input: Extract<ThreadLaunchInput, { agent: unknown }>,
    ) => Effect.Effect<
      import("../orchestration-v2/ThreadLaunchService.ts").ThreadLaunchResult,
      ThreadLaunchError
    >;
  }
>()("t3/agents/AgentConversationLaunch/AgentConversationLauncher") {}

export const layer = Layer.effect(
  AgentConversationLauncher,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ServerConfig
      | ProjectionProjectRepository
      | ThreadManagementService
      | CommandReceiptStoreV2
      | IdAllocatorV2
    >();
    return AgentConversationLauncher.of({
      launch: (input) => launchAgentConversation(input).pipe(Effect.provide(context)),
    });
  }),
);
