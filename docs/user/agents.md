# Agents

Open **Agents** from the sidebar to browse Eve agents grouped by project. Agents in each environment's home-directory `.t3` folder appear under **Global**, even when the home directory is not registered as a project.

```text
.t3/
  agents/
    assistant/
      agent.ts
      instructions.md
      subagents/
        researcher/
          instructions.md
```

Each runnable agent has an `agent.ts` configuration module and its own nested `subagents/`. Eve's supported JavaScript and TypeScript module extensions are recognized too. Single-agent layouts under `.t3/agent/` and flat definitions directly in `.t3/` are also supported; a single root takes precedence over workspace members.

Choose **Create agent** and select Global or a project to name an agent and add Markdown instructions. Groups appear in the catalog once they contain agents. Choose **Edit instructions** on an existing agent to update its Markdown sources. In single-agent layouts, new agents are created as subagents of the root agent. New agents contain instructions only; add an `agent.ts` model configuration before using them in a workflow. Skills and executable instruction modules are still managed on disk.

You can also edit the files on disk and refresh the catalog to see changes. YAML files are not agent entries in this catalog. Catalog discovery does not execute agent modules. Starting a verified workflow loads the referenced agents' configuration and Markdown instructions, then runs them through T3's provider harnesses. Ordinary threads do not apply agent definitions yet.

Each agent chooses its provider and model in `agent.ts`:

```ts
export default {
  model: "anthropic/claude-sonnet-4-6",
};
```

Use `openai/<model>` for the Codex harness or `anthropic/<model>` for the Claude Code harness. These select the environment's default instance of that provider and use its existing authentication, including subscriptions. The thread's model picker does not override an agent's selection. The configuration supports `model` and an optional `description`; Eve API model objects and runtime capability settings are unsupported. An Eve `defineAgent(...)` export is also accepted when the project has Eve installed.

Agent configuration modules are trusted project code. Workflow creation evaluates them and saves a snapshot; edits apply to newly created workflows. See [Verified workflows](verified-workflows.md#configuration) for stage configuration and skill restrictions.
