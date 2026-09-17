import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type AgentDefinitionDocument,
  type AgentDefinitionSaveInput,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { projectEnvironment } from "../../state/projects";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type Target = { environmentId: EnvironmentId; projectId: ProjectId; settings: ServerSettings };
type EditorTarget = { type: "edit"; id: string } | { type: "create"; parentId: string | null };

/** Each checkout owns its files; edits never fan out across machines. */
export function AgentDefinitionsSettings() {
  const { targets, scope } = useSettingsScope();
  return (
    <div id="agent-definitions" className="space-y-6">
      {targets.map((target) =>
        target.projectId === null ? null : (
          <AgentCatalog
            key={`${target.environmentId}:${target.projectId}`}
            {...target}
            projectId={target.projectId}
            label={`${target.label} · ${scope.kind === "project" || scope.kind === "checkout" ? (scope.members.find((member) => member.environmentId === target.environmentId && member.id === target.projectId)?.workspaceRoot ?? "") : ""}`}
          />
        ),
      )}
    </div>
  );
}

function AgentCatalog(target: Target & { label: string }) {
  const { environmentId, projectId } = target;
  const catalog = useEnvironmentQuery(
    projectEnvironment.agentDefinitions({ environmentId, input: { projectId } }),
  );
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const definitions = catalog.data ?? [];
  const canAddRoot = !definitions.some(
    (entry) => entry.parentId === null && !entry.directory.startsWith("agents/"),
  );
  const close = () => {
    setEditor(null);
    catalog.refresh();
  };
  return (
    <SettingsSection title={`Agents · ${target.label}`}>
      <p className="text-sm text-muted-foreground">
        Create reusable agents with instructions, models, and their own subagents. Changes apply to
        new threads.
      </p>
      <div className="flex gap-2 py-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!canAddRoot || editor !== null}
          onClick={() => setEditor({ type: "create", parentId: null })}
        >
          New agent
        </Button>
        <Button size="sm" variant="ghost" onClick={catalog.refresh}>
          Refresh
        </Button>
      </div>
      {catalog.error ? (
        <p role="alert" className="text-sm text-destructive">
          {catalog.error}
        </p>
      ) : null}
      {catalog.isPending && !catalog.data ? (
        <p className="text-sm text-muted-foreground">Loading agents…</p>
      ) : null}
      {catalog.isSuccess && definitions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No agents in this project yet.</p>
      ) : null}
      <div className="space-y-2">
        {definitions.map((agent) => (
          <div key={agent.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {agent.parentId ? "↳ " : ""}
                {agent.name}
              </div>
              <div className="break-all text-xs text-muted-foreground">{agent.directory}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={editor !== null}
              onClick={() => setEditor({ type: "edit", id: agent.id })}
            >
              Open
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={editor !== null}
              onClick={() => setEditor({ type: "create", parentId: agent.id })}
            >
              Add subagent
            </Button>
          </div>
        ))}
      </div>
      {editor ? (
        <AgentEditorLoader
          key={JSON.stringify(editor)}
          target={target}
          editor={editor}
          onClose={close}
        />
      ) : null}
    </SettingsSection>
  );
}

function AgentEditorLoader({
  target,
  editor,
  onClose,
}: {
  target: Target;
  editor: EditorTarget;
  onClose: () => void;
}) {
  const document = useEnvironmentQuery(
    editor.type === "edit"
      ? projectEnvironment.agentDefinition({
          environmentId: target.environmentId,
          input: { projectId: target.projectId, id: editor.id },
        })
      : null,
  );
  if (editor.type === "edit" && !document.data)
    return (
      <div className="space-y-2 py-3">
        <p role={document.error ? "alert" : undefined}>{document.error ?? "Loading agent…"}</p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  return (
    <AgentEditor
      key={document.data?.revision ?? "new"}
      target={target}
      editor={editor}
      document={document.data}
      onClose={onClose}
      onReload={document.refresh}
    />
  );
}

function AgentEditor({
  target,
  editor,
  document: initialDocument,
  onClose,
  onReload,
}: {
  target: Target;
  editor: EditorTarget;
  document: AgentDefinitionDocument | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const { environmentId, projectId, settings } = target;
  const [document, setDocument] = useState(initialDocument);
  const navigate = useNavigate();
  const modelSettings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instances = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const first = instances[0];
  const fallback =
    settings.defaultModelSelection ??
    (first?.models[0] ? { instanceId: first.instanceId, model: first.models[0].slug } : null);
  const [name, setName] = useState(document?.config.name ?? "");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState(document?.config.description ?? "");
  const [instructions, setInstructions] = useState(document?.instructions ?? "");
  const [selection, setSelection] = useState<ModelSelection | null>(
    document?.config.modelSelection ?? null,
  );
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useAtomCommand(projectEnvironment.saveAgentDefinition, { reportFailure: false });
  const remove = useAtomCommand(projectEnvironment.deleteAgentDefinition, { reportFailure: false });
  const launch = useAtomCommand(orchestrationEnvironment.v2.launchThread, { reportFailure: false });
  const active = selection ?? fallback;
  const models = useMemo(
    () =>
      getCustomModelOptionsByInstance(modelSettings, providers, active?.instanceId, active?.model),
    [modelSettings, providers, active?.instanceId, active?.model],
  );
  const editable =
    !document ||
    (!document.definition.configurationPath?.endsWith(".ts") &&
      document.definition.instructionPaths.every((file) => file.endsWith("instructions.md")));

  const submit = async (start: boolean) => {
    if (busy || !name.trim() || (start && (!active || !prompt.trim()))) return;
    setBusy(true);
    setError(null);
    const result = await save({
      environmentId,
      input: {
        projectId,
        target: document
          ? { type: "update", id: document.definition.id, expectedRevision: document.revision }
          : { type: "create", slug, parentId: editor.type === "create" ? editor.parentId : null },
        config: {
          version: 1,
          name: name.trim(),
          description,
          ...(selection ? { modelSelection: selection } : {}),
        },
        instructions,
      } satisfies AgentDefinitionSaveInput,
    });
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      setBusy(false);
      return;
    }
    setDocument(result.value);
    if (start && active) {
      const started = await launch({
        environmentId,
        input: {
          commandId: CommandId.make(randomUUID()),
          projectId,
          title: name.trim(),
          modelSelection: active,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: "default",
          agentDefinitionId: result.value.definition.id,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: prompt.trim(), attachments: [] },
        },
      });
      if (started._tag === "Failure") {
        setError(`Agent saved, but could not start: ${String(squashAtomCommandFailure(started))}`);
        setBusy(false);
        return;
      }
      onClose();
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: started.value.threadId },
      });
    } else onClose();
    setBusy(false);
  };
  const deleteAgent = async () => {
    if (!document || busy) return;
    setBusy(true);
    setError(null);
    const result = await remove({
      environmentId,
      input: { projectId, id: document.definition.id, expectedRevision: document.revision },
    });
    setBusy(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else onClose();
  };

  return (
    <div className="mt-4 space-y-4 rounded-lg border p-4">
      <h3 className="text-sm font-medium">
        {document
          ? `Edit ${document.config.name}`
          : editor.type === "create" && editor.parentId
            ? "New subagent"
            : "New agent"}
      </h3>
      {!editable ? (
        <p role="alert" className="text-sm text-muted-foreground">
          This definition uses source files that the editor cannot change. Convert it to agent.json
          and instructions.md to edit it here.
        </p>
      ) : null}
      <fieldset disabled={busy || !editable} className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span>Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {!document ? (
          <label className="block space-y-1 text-sm">
            <span>Folder name</span>
            <Input
              value={slug}
              placeholder="google"
              pattern="[a-z][a-z0-9_-]{0,63}"
              onChange={(event) => setSlug(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              Lowercase letters, numbers, underscores, and hyphens.
            </span>
          </label>
        ) : null}
        <label className="block space-y-1 text-sm">
          <span>Description</span>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Instructions</span>
          <Textarea
            className="min-h-48 font-mono"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selection !== null}
            disabled={!active}
            onChange={(event) => setSelection(event.target.checked ? active : null)}
          />
          Use a specific model
        </label>
        {selection && active ? (
          <ProviderModelPicker
            activeInstanceId={active.instanceId}
            model={active.model}
            lockedProvider={null}
            instanceEntries={instances}
            modelOptionsByInstance={models}
            onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Uses the parent agent’s model when delegated, or the project’s default when started
            directly.
          </p>
        )}
        <label className="block space-y-1 text-sm">
          <span>Task to start now (optional)</span>
          <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </label>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            busy ||
            !editable ||
            !name.trim() ||
            (editor.type === "create" && !/^[a-z][a-z0-9_-]{0,63}$/.test(slug))
          }
          onClick={() => void submit(false)}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            busy ||
            !editable ||
            !name.trim() ||
            !prompt.trim() ||
            !active ||
            (editor.type === "create" && !/^[a-z][a-z0-9_-]{0,63}$/.test(slug))
          }
          onClick={() => void submit(true)}
        >
          Save and start
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Close
        </Button>
        {document ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReload}>
            Reload saved version
          </Button>
        ) : null}
        {document && document.definition.directory !== "." ? (
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        ) : null}
      </div>
      {confirmDelete ? (
        <div className="space-y-2 text-sm">
          <p>
            Delete this agent folder, including its skills and all nested subagents? Existing
            threads keep their saved instructions.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void deleteAgent()}
          >
            Delete agent and subagents
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
