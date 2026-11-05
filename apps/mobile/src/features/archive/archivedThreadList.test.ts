import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { buildArchivedThreadGroups } from "./archivedThreadList";
import { makeRawThreadShell } from "../../test-fixtures";

const environmentId = EnvironmentId.make("environment-1");

function makeThread(
  input: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "title"> & {
    readonly branch?: string | null;
    readonly archivedAt?: string | null;
  },
): OrchestrationV2ThreadShell {
  const archivedAt = input.archivedAt === undefined ? "2026-06-02T00:00:00.000Z" : input.archivedAt;
  return makeRawThreadShell({
    ...input,
    archivedAt: archivedAt === null ? null : DateTime.makeUnsafe(archivedAt),
  });
}

function makeSnapshot(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  targetEnvironmentId = environmentId,
): ArchivedSnapshotEntry {
  return {
    environmentId: targetEnvironmentId,
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: 1,
      projects,
      threads,
    },
  };
}

describe("buildArchivedThreadGroups", () => {
  it("keeps same-named agent histories separate after their source projects disappear", () => {
    const conversation = makeThread({
      id: ThreadId.make("agent-first"),
      projectId: null,
      title: "Essay",
    });
    const owner = {
      agentId: ".t3/agents/writer",
      sourceProjectId: ProjectId.make("removed-source"),
      name: "Writer",
    };
    const result = buildArchivedThreadGroups({
      snapshots: [
        makeSnapshot(
          [],
          [
            { ...conversation, agent: owner },
            {
              ...conversation,
              id: ThreadId.make("agent-second"),
              agent: { ...owner, sourceProjectId: null },
            },
          ],
        ),
        makeSnapshot(
          [],
          [{ ...conversation, agent: owner }],
          EnvironmentId.make("other-environment"),
        ),
      ],
      environmentLabels: {},
      environmentId: null,
      searchQuery: "writer",
      sortOrder: "newest",
    });
    expect(result).toHaveLength(3);
    expect(result.every((group) => group.project === null && group.threads.length === 1)).toBe(
      true,
    );
    expect(new Set(result.map((group) => group.key)).size).toBe(3);
  });
});
