import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceService from "./DeviceService.ts";

/**
 * With exclusive device access on, a thread gives its devices back when its turn ends or the
 * thread is settled, archived or deleted, so an agent that forgets `device_close` cannot keep
 * the next thread waiting. A later turn that needs the device opens it again.
 */
export class DeviceReleaseReactor extends Context.Service<
  DeviceReleaseReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/device/DeviceReleaseReactor") {}

const ENDED_RUN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);
const RELEASING_THREAD_EVENTS = new Set(["thread.settled", "thread.archived", "thread.deleted"]);

/** The thread whose devices an event releases, if any. */
export const releasedThread = (event: OrchestrationV2DomainEvent): ThreadId | undefined => {
  if (event.type === "run.updated") {
    return ENDED_RUN_STATUSES.has(event.payload.status) ? event.threadId : undefined;
  }
  return RELEASING_THREAD_EVENTS.has(event.type) ? event.threadId : undefined;
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const devices = yield* DeviceService.DeviceService;
  const settings = yield* ServerSettings.ServerSettingsService;

  const handle: DeviceReleaseReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      const threadId = releasedThread(event);
      if (threadId === undefined) return;
      if ((yield* devices.sessionsForThread(threadId)).length === 0) return;
      const current = yield* settings.getSettings;
      if (!current.exclusiveDeviceAccess) return;
      yield* devices.close({ threadId });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("releasing a thread's devices failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DeviceReleaseReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("device release event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DeviceReleaseReactor["Service"];
});

export const layer = Layer.effect(DeviceReleaseReactor, make);
