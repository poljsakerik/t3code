# Verified workflows

Verified workflows are an opt-in orchestration layer on top of ordinary V2 threads. The provider adapters are unchanged: planners, implementers, and reviewers are selected through normal `ModelSelection`, messages use normal orchestration commands, and reviewer isolation uses normal thread forks. This keeps the feature harness agnostic.

The durable state is `ThreadWorkflowState` in [`packages/contracts/src/workflow.ts`](../../packages/contracts/src/workflow.ts). It snapshots the resolved profile at creation so a running workflow does not change when YAML is edited. Ordinary threads have no workflow state.

```text
draft → planning → planned → implementing → checking → reviewing → done
                                ↑              │          │
                                └── revising ←─┴──────────┘
                                       │
                                       └── needs_human
```

[`WorkflowConfigService.ts`](../../apps/server/src/workflows/WorkflowConfigService.ts) resolves global YAML/JSON first and repository YAML/JSON second, overriding by ID. Profiles reference one planner, one implementer, at least one unique reviewer, and at least one sequential shell check.

[`WorkflowCoordinator.ts`](../../apps/server/src/workflows/WorkflowCoordinator.ts) is an event-driven reactor. It resumes incomplete workflows at startup and reacts to plan, run, checkpoint, message, and workflow events. It never marks `done` from agent prose. Completion requires persisted passing check evidence, valid structured reviewer responses, unanimous approval, and an unchanged workspace digest while reviews run.

Reviewers run concurrently in forked, plan-mode threads and receive the approved plan plus check results. Their strict JSON result is projected back into the parent workflow. Any rejection or invalid reviewer result starts a new implementer revision, after which every check and every reviewer runs again. Repeated identical failures and exhausted revision limits transition to `needs_human`; a user message starts a fresh revision with that guidance.

The web command palette currently starts the `default` profile. Workflow metadata travels through the shared launch contract, so other clients can create the same thread kind without provider-specific behavior.
