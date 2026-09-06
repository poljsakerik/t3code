import {
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { createEnvironmentThreadStateAtoms, type ThreadSnapshotLoader } from "./threads.ts";

describe("createEnvironmentThreadStateAtoms", () => {
  it("retains thread state across short subscriber gaps", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const atom = threads.stateAtom(environmentId, threadId);

    expect(atom.idleTTL).toBe(THREAD_STATE_IDLE_TTL_MS);
    expect(threads.stateAtom(environmentId, threadId)).toBe(atom);
    expect(threads.stateAtom(environmentId, ThreadId.make("thread-2"))).not.toBe(atom);
  });
});

describe("createEnvironmentThreadShellAtoms", () => {
  it("keeps subagents addressable while projecting them out of navigation", () => {
    const environmentId = EnvironmentId.make("environment-navigation");
    const projectId = ProjectId.make("project-navigation");
    const parentThreadId = ThreadId.make("thread-navigation-parent");
    const childThreadId = ThreadId.make("thread-navigation-subagent");
    const now = DateTime.makeUnsafe("2026-09-06T00:00:00.000Z");
    const makeShell = (
      id: ThreadId,
      lineage: OrchestrationV2ThreadShell["lineage"],
    ): OrchestrationV2ThreadShell => ({
      id,
      projectId,
      title: String(id),
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage,
      forkedFrom: null,
      activeProviderThreadId: null,
      createdBy: "user",
      creationSource: "web",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    });
    const snapshot = {
      schemaVersion: 1,
      snapshotSequence: 1,
      projects: [],
      archivedThreads: [],
      threads: [
        makeShell(parentThreadId, {
          rootThreadId: parentThreadId,
          parentThreadId: null,
          relationshipToParent: null,
        }),
        makeShell(childThreadId, {
          rootThreadId: parentThreadId,
          parentThreadId: parentThreadId,
          relationshipToParent: "subagent",
        }),
      ],
    } satisfies OrchestrationV2ShellSnapshot;
    const catalogValueAtom = Atom.make({
      isReady: true,
      entries: new Map([[environmentId, {} as never]]),
    } satisfies EnvironmentCatalogState);
    const snapshotAtom = Atom.make<OrchestrationV2ShellSnapshot | null>(snapshot);
    const shells = createEnvironmentThreadShellAtoms({
      catalogValueAtom,
      snapshotAtom: () => snapshotAtom,
    });
    const registry = AtomRegistry.make();

    expect(registry.get(shells.threadShellsAtom).map((thread) => thread.id)).toEqual([
      parentThreadId,
      childThreadId,
    ]);
    expect(registry.get(shells.navigationThreadShellsAtom).map((thread) => thread.id)).toEqual([
      parentThreadId,
    ]);
    expect(
      registry
        .get(shells.navigationThreadShellsForProjectRefsAtom([{ environmentId, projectId }]))
        .map((thread) => thread.id),
    ).toEqual([parentThreadId]);
    expect(
      registry.get(shells.threadShellAtom({ environmentId, threadId: childThreadId }))?.id,
    ).toBe(childThreadId);
  });
});
