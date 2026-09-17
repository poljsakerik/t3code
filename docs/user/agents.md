# Agents

Agents are reusable instructions with an optional provider and model, Markdown skills, and nested subagents. They run through your configured T3 providers and accounts.

In **Settings → Project**, choose the project and checkout, then use **Agents** to create an agent or add a subagent. Give each agent instructions and a description explaining when to use it. Leave its model unset to inherit the calling agent's model; starting it directly uses the project's default model, or an available model if no default is configured. Enter a task and choose **Save and start** to open its conversation. The chat header identifies the agent.

Definitions live in the selected environment's project directory. You can edit and version these files directly:

```text
agents/
  google/
    agent/
      agent.json
      instructions.md
      skills/
        inbox-triage.md
      subagents/
        gmail/
          agent.json
          instructions.md
```

```json
{
  "version": 1,
  "name": "Google",
  "description": "Coordinate work across Google services"
}
```

To pin a model, add `modelSelection` with `instanceId` and `model`, using the provider instance configured in Settings. The editor can select these for you.

A single root in `agent/`, flat definitions at the project root, and flat workspace members under `agents/<name>/` are also recognized. A single root takes precedence over workspace members. Workspace members with their own `package.json` belong to separate projects. Markdown instructions can also be assembled from an `instructions/` directory; edit that layout directly in files.

Named subagents receive their own instructions and declared children. T3's delegation tools track their work and results. They do not inherit the parent's authored instructions or skills. Provider-configured tools and skills remain available: agent folders do not create a separate permission boundary. Google services, for example, still need to be connected through the chosen provider.

T3 saves the agent's instructions, configuration, and child definitions when a thread starts. Edits apply to new threads; existing threads retain their saved definitions. Skill files are read from the checkout when needed. Deleting a folder removes its skills and nested agents as well, but keeps existing conversations.

This uses Eve's folder organization with T3's declarative `agent.json` configuration. Eve's executable `agent.ts`, TypeScript instructions or skill modules, and authored tools, connections, extensions, hooks, memory, sandbox, channels, and schedules require runtime support beyond this format. T3 rejects them at launch instead of silently ignoring them.
