import { AgentSkillsEditor } from "./AgentSkillsEditor";
import { useId, useRef, useState } from "react";
import type {
  AgentDefinition,
  AgentInstructionDocument,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { projectEnvironment } from "../state/projects";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

export function AgentEditorDialog({
  environmentId,
  projectId,
  agent,
  parent,
  scopeLabel,
  onClose,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  agent: AgentDefinition | null;
  parent: AgentDefinition | null;
  scopeLabel: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const detail = useEnvironmentQuery(
    agent
      ? projectEnvironment.agentDefinition({
          environmentId,
          input: { ...(projectId === undefined ? {} : { projectId }), agentId: agent.id },
        })
      : null,
  );
  const [tab, setTab] = useState<"instructions" | "skills">("instructions");
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const close = () => {
    if (saving || skillsBusy) return;
    if (dirty) setDiscarding(true);
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-2xl" showCloseButton={!saving && !skillsBusy}>
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : "Create agent"}</DialogTitle>
          <DialogDescription>
            {scopeLabel}
            {!agent && parent ? ` · Subagent of ${parent.name}` : ""}
          </DialogDescription>
        </DialogHeader>
        {agent ? (
          <div className="flex gap-2 px-6 pb-4" role="group" aria-label="Agent settings">
            <Button
              variant={tab === "instructions" ? "secondary" : "ghost"}
              size="sm"
              disabled={saving || skillsBusy}
              onClick={() => setTab("instructions")}
              aria-pressed={tab === "instructions"}
            >
              Instructions
            </Button>
            <Button
              variant={tab === "skills" ? "secondary" : "ghost"}
              size="sm"
              disabled={dirty || saving || skillsBusy || detail.data === null}
              onClick={() => setTab("skills")}
              aria-pressed={tab === "skills"}
            >
              Skills
            </Button>
          </div>
        ) : null}
        {agent && tab === "skills" ? (
          <AgentSkillsEditor
            environmentId={environmentId}
            {...(projectId === undefined ? {} : { projectId })}
            agentId={agent.id}
            installedSkills={detail.data?.installedSkills ?? []}
            onChanged={detail.refresh}
            onBusyChange={setSkillsBusy}
          />
        ) : (
          <>
            {discarding ? (
              <div className="mx-6 mb-4 space-y-3 rounded-lg border p-3">
                <p className="text-sm">Discard your unsaved changes?</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setDiscarding(false)}>
                    Keep editing
                  </Button>
                  <Button size="sm" variant="destructive" onClick={onClose}>
                    Discard changes
                  </Button>
                </div>
              </div>
            ) : null}
            {agent && (!detail.data || (detail.isPending && !dirty && !saving)) ? (
              <div className="space-y-3 px-6 pb-6">
                {detail.error ? (
                  <>
                    <p role="alert" className="text-sm text-destructive-foreground">
                      {detail.error}
                    </p>
                    <Button variant="outline" onClick={detail.refresh}>
                      Try again
                    </Button>
                  </>
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading instructions…
                  </p>
                )}
              </div>
            ) : (
              <AgentEditorForm
                environmentId={environmentId}
                {...(projectId === undefined ? {} : { projectId })}
                agent={agent}
                parent={parent}
                documents={detail.data?.documents ?? [{ path: "instructions.md", content: null }]}
                otherInstructionPaths={detail.data?.otherInstructionPaths ?? []}
                onDirtyChange={setDirty}
                onSavingChange={setSaving}
                onClose={close}
                onSaved={() => {
                  if (agent) detail.refresh();
                  onSaved();
                }}
              />
            )}
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function AgentEditorForm({
  environmentId,
  projectId,
  agent,
  parent,
  documents,
  otherInstructionPaths,
  onDirtyChange,
  onSavingChange,
  onClose,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId?: ProjectId;
  agent: AgentDefinition | null;
  parent: AgentDefinition | null;
  documents: ReadonlyArray<AgentInstructionDocument>;
  otherInstructionPaths: ReadonlyArray<string>;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Keep the loaded version paired with the draft even if the query refreshes.
  const [sources] = useState(documents);
  const [selected, setSelected] = useState(sources[0]);
  const [name, setName] = useState("");
  const [content, setContent] = useState(selected?.content ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const create = useAtomCommand(projectEnvironment.createAgentDefinition, { reportFailure: false });
  const update = useAtomCommand(projectEnvironment.updateAgentDefinition, { reportFailure: false });
  const dirty = content !== (selected?.content ?? "") || (!agent && name.length > 0);
  const validName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name.trim());
  const save = async () => {
    if (savingRef.current || !selected || (!agent && (!validName || !content.trim()))) return;
    savingRef.current = true;
    setSaving(true);
    onSavingChange(true);
    setError(null);
    const scope = projectId === undefined ? {} : { projectId };
    try {
      const result = agent
        ? await update({
            environmentId,
            input: {
              ...scope,
              agentId: agent.id,
              path: selected.path,
              content,
              expectedContent: selected.content,
            },
          })
        : await create({
            environmentId,
            input: {
              ...scope,
              ...(parent ? { parentId: parent.id } : {}),
              name: name.trim(),
              instructions: content,
            },
          });
      if (result._tag === "Success") onSaved();
      else setError(formatEnvironmentQueryError(result.cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  };
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-5 overflow-y-auto px-6 pb-6">
        {!agent ? (
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={80}
              required
              disabled={saving}
              placeholder="code-reviewer"
              aria-describedby={`${id}-name-hint`}
              onChange={(event) => {
                setName(event.target.value);
                onDirtyChange(event.target.value.length > 0 || content.length > 0);
              }}
            />
            <p className="text-xs text-muted-foreground">
              After creating the agent, open its Skills tab to add skills.
            </p>
            <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
              Start with a letter or number. Use letters, numbers, hyphens, or underscores.
            </p>
          </div>
        ) : null}
        {sources.length > 1 ? (
          <div className="space-y-2">
            <Label htmlFor={`${id}-source`}>Instruction source</Label>
            <select
              id={`${id}-source`}
              className="h-9 w-full rounded-lg border bg-background px-2 text-sm"
              value={selected?.path}
              disabled={saving || dirty}
              onChange={(event) => {
                const next = sources.find((source) => source.path === event.target.value);
                setSelected(next);
                setContent(next?.content ?? "");
                setError(null);
                onDirtyChange(false);
              }}
            >
              {sources.map((source) => (
                <option key={source.path} value={source.path}>
                  {source.path.slice((agent?.directory.length ?? -1) + 1)}
                </option>
              ))}
            </select>
            {dirty ? (
              <p className="text-xs text-muted-foreground">
                Save or discard changes before editing another source.
              </p>
            ) : null}
          </div>
        ) : null}
        {selected ? (
          <div className="space-y-2">
            <Label htmlFor={`${id}-instructions`}>Instructions</Label>
            <p id={`${id}-instructions-hint`} className="text-xs text-muted-foreground">
              Describe what this agent should do and how it should work. Markdown is supported.
            </p>
            <Textarea
              id={`${id}-instructions`}
              value={content}
              disabled={saving}
              maxLength={1_000_000}
              required={!agent}
              aria-describedby={`${id}-instructions-hint`}
              className="font-mono text-sm"
              style={{ fieldSizing: "fixed", minHeight: "16rem" }}
              placeholder="You are a code reviewer. Focus on correctness, clarity, and…"
              onChange={(event) => {
                setContent(event.target.value);
                onDirtyChange(
                  event.target.value !== (selected.content ?? "") || (!agent && name.length > 0),
                );
              }}
            />
          </div>
        ) : null}
        {otherInstructionPaths.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Additional instruction sources must be edited on disk:{" "}
            {otherInstructionPaths.join(", ")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={saving || !selected || !dirty || (!agent && (!validName || !content.trim()))}
        >
          {saving ? "Saving…" : agent ? "Save changes" : "Create agent"}
        </Button>
      </DialogFooter>
    </form>
  );
}
