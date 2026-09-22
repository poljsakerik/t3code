import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadRouteRef } from "./threadRoutes";

export function agentConversationRefFromHref(href: string) {
  const parts = href.split("/");
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  try {
    return resolveThreadRouteRef({
      environmentId: decodeURIComponent(parts[1]),
      threadId: decodeURIComponent(parts[2]),
    });
  } catch {
    return null;
  }
}

/** Archived or removed conversations cannot be restored by ordinary thread navigation. */
export function resolveAgentConversationHref(
  href: string,
  thread: Pick<
    EnvironmentThreadShell,
    "id" | "environmentId" | "agent" | "archivedAt" | "deletedAt"
  > | null,
): string {
  const ref = agentConversationRefFromHref(href);
  return ref !== null &&
    thread !== null &&
    ref.environmentId === thread.environmentId &&
    ref.threadId === thread.id &&
    thread.agent !== undefined &&
    thread.archivedAt === null &&
    thread.deletedAt === null
    ? href
    : "/agents";
}
