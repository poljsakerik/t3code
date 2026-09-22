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

Choose **Create agent** and select Global or a project to name an agent and add Markdown instructions. Groups appear in the catalog once they contain agents. Choose **Edit agent** on an existing agent to update its Markdown sources. In single-agent layouts, new agents are created as subagents of the root agent. New agents contain instructions only; add an `agent.ts` model configuration before starting a conversation or using them in a workflow. Executable instruction modules are still managed on disk.

To add a skill, choose **Edit agent → Skills**. Search skills.sh (for example, “impeccable”), or enter a GitHub repository and skill name, then choose **Add**. For Impeccable, use repository `pbakaus/impeccable` and skill name `impeccable`. Installed skills can be removed from the same tab.

Skills belong only to the selected agent and are stored in its `skills/<name>/` folder with their supporting files. They are not installed for other agents or into a provider's shared skill catalog. The environment needs Node.js, npm, Git, and network access to download skills. New workflows include the attached skill instructions. Removing a skill deletes its supporting files, so finish any workflows using it first.

You can also edit the files on disk and refresh the catalog to see changes. YAML files are not agent entries in this catalog. Catalog discovery does not execute agent modules. Starting a verified workflow loads the referenced agents' configuration and Markdown instructions, then runs them through T3's provider harnesses. Code threads keep their ordinary project setup.

Each agent chooses its provider and model in `agent.ts`:

```ts
export default {
  model: "anthropic/claude-sonnet-4-6",
};
```

Use `openai/<model>` for the Codex harness or `anthropic/<model>` for the Claude Code harness. These select the environment's default instance of that provider and use its existing authentication, including subscriptions. The thread's model picker does not override an agent's selection. The configuration supports `model` and an optional `description`; Eve API model objects and runtime capability settings are unsupported. An Eve `defineAgent(...)` export is also accepted when the project has Eve installed.

Agent configuration modules are trusted project code. Starting a conversation or creating a workflow evaluates them and saves a snapshot; edits apply to newly created conversations and workflows. See [Verified workflows](verified-workflows.md#configuration) for stage configuration and skill restrictions.

## Direct conversations

Switch the sidebar from **Code** to **Agents**, find an agent, and choose **New conversation**. Conversations appear beneath their agent, with project and environment labels to distinguish agents with the same name. Choose **Browse agents** on web or desktop to open the existing editor. Mobile can start and continue conversations with agents already defined on its connected environment.

A conversation uses the agent's instructions, installed skills and supporting files, and configured provider/model. You can send follow-ups and attachments, stop a turn, rename the conversation, and archive or restore it. Switching modes leaves running conversations active. Model selection comes from the saved agent setup.

The source project only supplies the definition. Direct conversations run in their own managed directory, without attaching a project or worktree or loading its instructions. They can run installed commands such as `gh` and access the network using the environment's existing CLI authentication. For a PR review, provide the GitHub URL; no project checkout is required. Commands use supervised permissions, with approval requests when additional access is needed. Git, terminal, and checkpoint controls tied to a project remain unavailable. Codex needs a version supporting named permission profiles; Claude needs its filesystem sandbox available.

Existing conversations retain their saved instructions, model, and installed skill files when the definition changes or disappears. Native provider skills must remain available; a missing required skill produces an error. Start a new conversation to use an edited definition. Eve tools, external connections, custom memory, and hooks are not part of direct conversations in this release.
