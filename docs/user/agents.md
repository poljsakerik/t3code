# Agent folders

Add an Eve workspace as a T3 project to register its agent folders. In **Settings → Project**, select the project or checkout to see its agents. Definitions are discovered from the files in that environment; nothing is copied or converted.

T3 recognizes a single `agent/` directory, a flat agent at the project root, or workspace members under `agents/<name>/agent/` and `agents/<name>/`. An agent is identified by `agent.ts`, `instructions.md`, `instructions.ts`, or an `instructions/` directory. Nested agents live under each agent's `subagents/` directory.

A single root takes precedence over workspace members. Members with their own `package.json` belong to separate projects. Symbolic links are not followed.

Edit, add, or remove folders on disk, then refresh the catalog. Registration currently makes agents visible only: T3 does not execute their TypeScript, launch them, or apply their instructions to threads.
