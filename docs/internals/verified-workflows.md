# Verified workflows

Verified workflows are an opt-in orchestration layer on top of ordinary V2 threads. Planners, implementers, and reviewers are selected through normal `ModelSelection`, and messages use normal orchestration commands. Each reviewer gets a clean subagent backing thread linked to the visible workflow thread; it does not inherit the implementation conversation.

The durable state is `ThreadWorkflowState` in [`packages/contracts/src/workflow.ts`](../../packages/contracts/src/workflow.ts). It snapshots the resolved profile at creation so a running workflow does not change when YAML is edited. Ordinary threads have no workflow state.

```text
draft → planning → planned → implementing → checking → reviewing → done
                                ↑              │          │
                                └── revising ←─┴──────────┘
                                       │
                                       └── needs_human
```

[`WorkflowConfigService.ts`](../../apps/server/src/workflows/WorkflowConfigService.ts) resolves global YAML/JSON first and repository YAML/JSON second, overriding by ID. Profiles reference one planner, one implementer, at least one unique reviewer, and at least one sequential shell check.

Reviewer definitions can declare a `skills` allowlist. Non-empty lists are rejected for planner and implementer definitions. Reviewer dispatches persist the list as `workflowSkillAllowlist` on their run and copy it into `ProviderAdapterV2RuntimePolicy`. Codex translates it to per-thread `skills.config` enablement entries, Claude passes the SDK's main-session `skills` filter, and OpenCode appends per-session deny-all and exact allow rules. These controls remove unlisted skills from model-facing discovery and reject attempts to load them; global provider settings are never mutated. Planner, implementer, and revision turns retain provider defaults.

Codex validates assigned names against `skills/list`. Claude passes the configured names directly to the SDK's native `skills` context filter without a separate initialization-inventory preflight. Plugin-qualified names must use the provider's canonical form.

An adapter advertises this guarantee with `workflowSkillIsolation: "native"`. Reviewer turns fail closed on adapters without it. Orchestration never natively forks a reviewer from the implementation thread; it creates a clean native thread and supplies only the approved plan and check evidence needed for the review, so already-loaded skills and conversation history cannot cross the reviewer boundary.

[`WorkflowCoordinator.ts`](../../apps/server/src/workflows/WorkflowCoordinator.ts) is an event-driven reactor. It resumes incomplete workflows at startup and reacts to plan, run, checkpoint, message, and workflow events. It never marks `done` from agent prose. Completion requires persisted passing check evidence, valid structured reviewer responses, unanimous approval, and an unchanged workspace digest while reviews run.

Reviewers run concurrently in fresh, plan-mode subagent threads and receive the approved plan plus check results. Those backing threads stay out of top-level thread lists. Their strict JSON result is projected back into the parent workflow. The normal delegation lifecycle creates and completes each `app_owned` subagent row and turn item. One `workflow_verification` turn item per revision preserves the check evidence, reviewer verdicts, findings, and child-thread links rendered by clients. Workflow updates only project that verification evidence; they do not separately create or update subagent execution records. Updating a round reuses its deterministic item ID; a repair creates a new revision ID, so previous rounds remain visible.

The coordinator uses `delegated_task.request`, the same command used by other app-owned subagents, with the completed implementation run as its parent. The exception to delegation's active-parent requirement applies only to reviewers registered in that run's current workflow review round. Stable command IDs determine the reviewer task and child-thread IDs and make retries idempotent. The command creates the task, addressable child thread, and initial run together. T3's shared subagent constructor and metadata inheritance remain unchanged. The workflow integration clears only the registered reviewer's inherited `workflow` state, so it participates in the parent workflow without becoming an independent workflow. Its provider conversation starts fresh through ordinary delegation. Backing threads remain in the canonical thread graph for direct links and relationship views, while their `subagent` lineage keeps them out of the existing top-level thread list.

Reviewer tasks use `completionWake: "manual"`. Standard delegated completion persists their results on the parent; the coordinator reads every result and decides when to continue. A rejected round sends all reviewer summaries, findings, and evidence to the implementer in one revision turn. Unanimous approval completes the workflow without an extra agent turn. Other delegated tasks retain their existing automatic wake policies.

During `implementing` and `revising`, provider `assistant_message` turn items are normalized to hidden `workflow_candidate_message` items. Their ordinary assistant conversation messages remain in the provider transcript, so follow-up runs and forks retain the real conversational context. A rejected candidate is never published as completed work. When the workflow reaches `done`, the server appends a normal `assistant_message` turn item for the final candidate after the approved `workflow_verification` item. Clients render that persisted sequence directly; they do not reorder timeline rows, so existing history cursors remain stable when approval appends the completion item.

Any rejection or invalid reviewer result starts a new implementer revision, after which every check and every reviewer runs again. The coordinator dispatches that provider input as a distinct hidden `workflow_instruction` turn item: adapters still receive ordinary turn-start input, but the durable timeline does not model it as a `user_message`. Repeated identical failures and exhausted revision limits transition to `needs_human`; a human-authored message starts a fresh revision with that guidance.

The web command palette currently starts the `default` profile. Workflow metadata travels through the shared launch contract, so other clients can create the same thread kind without provider-specific behavior.
