# Agents

Open **Agents** from the sidebar and select a project to see its Eve-style agent folders. T3 reads the selected environment's project-local `.t3` directory.

```text
.t3/
  agents/
    assistant/
      instructions.md
      subagents/
        researcher/
          instructions.md
```

Each agent can have an `agent.ts` configuration module and its own nested `subagents/`. Eve's supported JavaScript and TypeScript module extensions are recognized too. Single-agent layouts under `.t3/agent/` and flat definitions directly in `.t3/` are also supported; a single root takes precedence over workspace members.

Edit the files on disk and refresh the catalog to see changes. YAML files are not agent entries in this catalog. T3 does not execute agent modules or apply these definitions to threads yet.
