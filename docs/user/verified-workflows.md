# Verified workflows

Verified workflows turn a request into a plan, an implementation, deterministic checks, and independent agent reviews. A workflow is only marked **Verified** after every configured check passes and every configured reviewer approves the same repository revision.

Open the command palette and choose **New verified workflow**. The web app creates a planning thread with the `default` workflow profile. Ordinary new threads are unchanged and do not run this loop.

The planner may ask clarifying questions with A/B/C choices. When its proposed plan is ready, use the existing **Implement** action. T3 Code then:

1. runs the configured implementer;
2. runs checks sequentially, stopping at the first failure;
3. starts all configured reviewers in parallel;
4. sends failed checks and blocking review findings back to the implementer;
5. repeats all checks and reviews after every repair.

The thread moves to **Needs human** when the revision limit is exhausted, the same failure repeats, a run fails, or the workspace changes during review. Send a message with guidance to resume the loop. Workflow progress survives server restarts.

## Configuration

Workflow configuration is YAML or JSON and is read by the server that owns the project. Store machine-wide definitions below your T3 home:

```text
userdata/workflows/agents/*.{yaml,yml,json}
userdata/workflows/profiles/*.{yaml,yml,json}
```

A repository can override definitions with the same IDs:

```text
.t3/workflows/agents/*.{yaml,yml,json}
.t3/workflows/profiles/*.{yaml,yml,json}
```

To use another checked-in directory, set its workspace-relative path in `t3.json`:

```json
{
  "workflowsDirectory": "config/workflows"
}
```

The selected directory must contain the same `agents` and `profiles` subdirectories and must remain inside the project root.

Agent files are persistent named roles. Omitting `providerInstanceId` and `model` makes the role inherit the thread's current model; set both to pin a role to a configured provider instance and model.

```yaml
# agents/planner.yaml
version: 1
id: planner
name: Product planner
role: planner
instructions: Clarify material choices and produce an implementable plan.
```

```yaml
# agents/implementer.yaml
version: 1
id: implementer
name: Implementer
role: implementer
instructions: Implement the approved plan and address every gate failure.
```

```yaml
# agents/correctness.yaml
version: 1
id: correctness
name: Correctness reviewer
role: reviewer
instructions: Review correctness, regressions, and missing tests. Do not edit files.
```

The web command selects the profile whose ID is `default`:

```yaml
# profiles/default.yaml
version: 1
id: default
name: Default verified workflow
planner: planner
implementer: implementer
reviewers:
  - correctness
checks:
  - id: test
    name: Focused tests
    run: vp test run path/to/focused.test.ts
    timeoutMs: 600000
  - id: typecheck
    name: TypeScript
    run: vp run --filter your-package typecheck
  - id: build
    name: Build
    run: vp run --filter your-package build
limits:
  maxRevisionCycles: 3
  identicalFailureLimit: 2
```

Checks run as shell commands in the thread workspace, in listed order. Repository workflow configuration is trusted code: only use it for repositories whose contents you trust.
