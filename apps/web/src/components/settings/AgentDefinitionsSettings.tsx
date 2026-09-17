import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/** Agent folders belong to the selected environment's registered project. */
export function AgentDefinitionsSettings() {
  const { targets, scope } = useSettingsScope();
  return (
    <div id="agent-definitions" className="space-y-6">
      {targets.map((target) =>
        target.projectId === null ? null : (
          <AgentCatalog
            key={`${target.environmentId}:${target.projectId}`}
            environmentId={target.environmentId}
            projectId={target.projectId}
            label={`${target.label} · ${scope.kind === "project" || scope.kind === "checkout" ? (scope.members.find((member) => member.environmentId === target.environmentId && member.id === target.projectId)?.workspaceRoot ?? "") : ""}`}
          />
        ),
      )}
    </div>
  );
}

function AgentCatalog({
  environmentId,
  projectId,
  label,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
}) {
  const catalog = useEnvironmentQuery(
    projectEnvironment.agentDefinitions({ environmentId, input: { projectId } }),
  );
  return (
    <SettingsSection title={`Agents · ${label}`}>
      <p className="text-sm text-muted-foreground">
        Eve-style agent folders in this project appear here automatically. Manage their files in the
        project directory. Running agents from these definitions is not available yet.
      </p>
      <Button size="sm" variant="ghost" onClick={catalog.refresh}>
        Refresh
      </Button>
      {catalog.error ? (
        <p role="alert" className="text-sm text-destructive">
          {catalog.error}
        </p>
      ) : null}
      {catalog.isPending && !catalog.data ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : null}
      {catalog.isSuccess && catalog.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agent folders found. Add an agent/ folder or workspace members under agents/ with
          agent.ts, instructions.md, instructions.ts, or an instructions/ directory.
        </p>
      ) : null}
      <div className="space-y-2">
        {catalog.data?.map((agent) => (
          <div key={agent.id} className="rounded-md border p-3">
            <div className="text-sm font-medium">
              {agent.parentId ? "↳ " : ""}
              {agent.name}
            </div>
            <div className="break-all text-xs text-muted-foreground">{agent.directory}</div>
            {agent.parentId ? (
              <div className="break-all text-xs text-muted-foreground">
                Parent: {agent.parentId}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
