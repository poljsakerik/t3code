import { useRouter } from "@tanstack/react-router";
import { useAgentConversationNavigation } from "../agentConversationNavigation";
import { useThreadShell } from "../state/entities";
import {
  agentConversationRefFromHref,
  resolveAgentConversationHref,
} from "../agentConversationNavigation.logic";
import { Button } from "./ui/button";
export function AgentModeTabs() {
  const router = useRouter();
  const mode = useAgentConversationNavigation((state) => state.mode);
  const lastAgentsHref = useAgentConversationNavigation((state) => state.lastAgentsHref);
  const lastAgentThread = useThreadShell(agentConversationRefFromHref(lastAgentsHref));
  return (
    <div
      className="mx-(--sidebar-content-inset) [-webkit-app-region:no-drag] mb-1 flex gap-0.5 rounded-lg bg-sidebar-control-surface/60 p-1"
      aria-label="Conversation mode"
    >
      {(["code", "agents"] as const).map((value) => (
        <Button
          key={value}
          size="xs"
          variant={mode === value ? "secondary" : "ghost"}
          className="flex-1"
          aria-pressed={mode === value}
          onClick={() => {
            const state = useAgentConversationNavigation.getState();
            useAgentConversationNavigation.setState({ mode: value });
            void router.navigate({
              href:
                value === "code"
                  ? state.lastCodeHref
                  : resolveAgentConversationHref(lastAgentsHref, lastAgentThread),
            });
          }}
        >
          {value === "code" ? "Code" : "Agents"}
        </Button>
      ))}
    </div>
  );
}
