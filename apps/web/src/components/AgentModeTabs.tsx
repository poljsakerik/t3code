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
      className="no-drag mx-[var(--sidebar-content-inset)] mb-1 flex gap-0.5 rounded-lg bg-sidebar-control-surface/60 p-1"
      aria-label="Conversation mode"
    >
      {(["code", "agents"] as const).map((value) => (
        <Button
          key={value}
          size="sm"
          variant="ghost"
          className={`h-7 flex-1 rounded-md text-xs font-medium ${mode === value ? "bg-sidebar-row-active text-sidebar-foreground shadow-xs" : "text-sidebar-muted-foreground"}`}
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
