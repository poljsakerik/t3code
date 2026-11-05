import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export function scopedProjectKey(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): string {
  return projectId === null ? "" : `${environmentId}:${projectId}`;
}

export function scopedThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}
