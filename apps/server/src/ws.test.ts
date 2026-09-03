import { assert, describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  buildThreadLaunchServiceInput,
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

describe("buildThreadLaunchServiceInput", () => {
  it("preserves verified workflow launch metadata", () => {
    const input = buildThreadLaunchServiceInput({
      commandId: CommandId.make("launch-workflow"),
      projectId: ProjectId.make("project-1"),
      title: "Fix downloads",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      workflowProfileId: "default",
      workspaceStrategy: { type: "root" },
    });

    expect(input).toMatchObject({
      workflowProfileId: "default",
      interactionMode: "plan",
      createdBy: "user",
      creationSource: "web",
    });
  });
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);
