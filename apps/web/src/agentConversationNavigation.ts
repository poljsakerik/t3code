import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentConversationOwner, EnvironmentId } from "@t3tools/contracts";

export type AgentSelection = { environmentId: EnvironmentId; owner: AgentConversationOwner };
export const useAgentConversationNavigation = create(
  persist<{
    mode: "code" | "agents";
    selected: AgentSelection | null;
    lastCodeHref: string;
    lastAgentsHref: string;
  }>(() => ({ mode: "code", selected: null, lastCodeHref: "/", lastAgentsHref: "/agents" }), {
    name: "t3-agent-conversation-navigation",
  }),
);

/** The shared shell handles this action from menus, keyboard shortcuts, and the palette. */
export function requestNewAgentConversation(): boolean {
  if (useAgentConversationNavigation.getState().mode !== "agents") return false;
  window.dispatchEvent(new Event("t3-new-agent-conversation"));
  return true;
}
