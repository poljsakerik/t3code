import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Agent conversations have no project. Project-only paths (worktrees, scripts, pull requests,
 * secrets) are rejected for them at their entry points, so reaching one here is a bug.
 */
export const requireProjectId = (thread: {
  readonly id?: string;
  readonly threadId?: string;
  readonly projectId: ProjectId | null;
}): Effect.Effect<ProjectId> =>
  thread.projectId === null
    ? Effect.die(
        new Error(
          `Thread ${thread.id ?? thread.threadId ?? "unknown"} is an agent conversation and has no project.`,
        ),
      )
    : Effect.succeed(thread.projectId);
