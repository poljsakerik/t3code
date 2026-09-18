import { useId, useRef, useState } from "react";
import type {
  AgentInstalledSkill,
  AgentSkillSearchResult,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { projectEnvironment } from "../state/projects";
import { formatEnvironmentQueryError } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function AgentSkillsEditor({
  environmentId,
  projectId,
  agentId,
  installedSkills,
  onChanged,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  agentId: string;
  installedSkills: ReadonlyArray<AgentInstalledSkill>;
  onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AgentSkillSearchResult | null>(null);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const search = useAtomCommand(projectEnvironment.searchAgentSkills, { reportFailure: false });
  const install = useAtomCommand(projectEnvironment.installAgentSkill, { reportFailure: false });
  const remove = useAtomCommand(projectEnvironment.removeAgentSkill, { reportFailure: false });
  const scope = {
    environmentId,
    input: { agentId, ...(projectId === undefined ? {} : { projectId }) },
  };
  const run = async (
    operation: "search" | "install" | "remove",
    skill?: { source: string; name: string },
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(operation === "search" ? "search" : `${operation}:${skill?.name}`);
    onBusyChange(true);
    setError(null);
    setStatus(null);
    try {
      if (operation === "search") {
        setResults(null);
        const result = await search({ environmentId, input: { query: query.trim() } });
        if (result._tag === "Success") setResults(result.value);
        else setError(formatEnvironmentQueryError(result.cause));
      } else if (skill) {
        const result =
          operation === "install"
            ? await install({ ...scope, input: { ...scope.input, ...skill } })
            : await remove({ ...scope, input: { ...scope.input, name: skill.name } });
        if (result._tag === "Success") {
          setStatus(
            `${skill.name} ${operation === "install" ? "added to" : "removed from"} this agent.`,
          );
          onChanged();
        } else setError(formatEnvironmentQueryError(result.cause));
      }
    } finally {
      busyRef.current = false;
      setBusy(null);
      onBusyChange(false);
    }
  };
  const validSource = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source.trim());
  const validName = /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name.trim());
  return (
    <div className="max-h-[65vh] space-y-5 overflow-y-auto px-6 pb-6">
      <p className="text-sm text-muted-foreground">
        Skills added here belong only to this agent and are loaded when a new workflow is created.
      </p>
      <section className="space-y-2" aria-label="Installed skills">
        <h3 className="text-sm font-medium">Installed skills</h3>
        {installedSkills.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skills added yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {installedSkills.map((skill) => (
              <li key={skill.name} className="flex items-center gap-3 p-3">
                <span className="min-w-0 flex-1 break-words text-sm">{skill.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void run("remove", { source: "", name: skill.name })}
                  aria-label={`Remove ${skill.name} from this agent`}
                >
                  {busy === `remove:${skill.name}` ? "Removing…" : "Remove"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim().length >= 2) void run("search");
        }}
      >
        <Label htmlFor={`${id}-query`}>Find skills on skills.sh</Label>
        <div className="flex gap-2">
          <Input
            id={`${id}-query`}
            placeholder="Search skills, e.g. impeccable"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={100}
            disabled={busy !== null}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={busy !== null || query.trim().length < 2}
          >
            {busy === "search" ? "Searching…" : "Search"}
          </Button>
        </div>
      </form>
      {results ? (
        results.skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No matching skills. You can add one by repository below.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {results.skills.map((skill) => {
              const installed = installedSkills.some((item) => item.name === skill.name);
              return (
                <li key={`${skill.source}/${skill.name}`} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <a
                      href={`https://skills.sh/${skill.source}/${skill.name}`}
                      target="_blank"
                      rel="noreferrer"
                      className="break-words text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {skill.name}
                    </a>
                    <p className="break-words text-xs text-muted-foreground">
                      {skill.source} · {skill.installs.toLocaleString()} installs
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || installed}
                    onClick={() => void run("install", skill)}
                    aria-label={`Add ${skill.name} from ${skill.source}`}
                  >
                    {installed ? "Installed" : busy === `install:${skill.name}` ? "Adding…" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
      <form
        className="space-y-3 rounded-lg border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (validSource && validName)
            void run("install", { source: source.trim(), name: name.trim() });
        }}
      >
        <h3 className="text-sm font-medium">Add from GitHub</h3>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-source`}>Repository</Label>
          <Input
            id={`${id}-source`}
            placeholder="pbakaus/impeccable"
            value={source}
            maxLength={200}
            onChange={(event) => setSource(event.target.value)}
            disabled={busy !== null}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>Skill name</Label>
          <Input
            id={`${id}-name`}
            placeholder="impeccable"
            value={name}
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            disabled={busy !== null}
          />
        </div>
        <Button type="submit" size="sm" disabled={busy !== null || !validSource || !validName}>
          Add skill
        </Button>
      </form>
      {busy?.startsWith("install:") ? (
        <p role="status" className="text-sm text-muted-foreground">
          Downloading skill files…
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-sm">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
