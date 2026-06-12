# pi-workflow

**Workflow orchestration for Pi subagents.**

[![npm](https://img.shields.io/npm/v/@agwab/pi-workflow.svg)](https://www.npmjs.com/package/@agwab/pi-workflow)

`pi-workflow` turns multi-subagent work into explicit workflows that Pi can run, inspect, and resume. It builds on [`@agwab/pi-subagent`](https://www.npmjs.com/package/@agwab/pi-subagent) for durable worker execution and adds a workflow layer for stage graphs, fan-out/fan-in, transforms, and bounded loops.

npm package: [`@agwab/pi-workflow`](https://www.npmjs.com/package/@agwab/pi-workflow)

## Installation

```bash
pi install npm:@agwab/pi-workflow
```

Then reload Pi.

Requires Node.js `>=22.19.0`. Like Pi and `pi-subagent`, this package is intended for macOS or Linux; on Windows, use WSL2.

For local development, install the checkout as a Pi package source and reload Pi:

```bash
pi install /absolute/path/to/pi-workflow
```

## Quick usage

List bundled and project workflows:

```text
/workflow list
```

Ask Pi to recommend a workflow for a task:

```text
/workflow recommend "deeply research this repository and verify key claims"
```

Run a workflow by exact name:

```text
/workflow run deep-research "Research this repo and summarize the architecture tradeoffs."
```

```text
/workflow run deep-review "Review the current diff from multiple angles."
```

```text
/workflow run implement-loop "Implement the requested small fix, run validation, and stop when the check accepts."
```

Inspect a run:

```text
/workflow status
/workflow status workflow_mq224pi8_775e71
/workflow show workflow_mq224pi8_775e71
/workflow logs workflow_mq224pi8_775e71 task-1 80
/workflow wait workflow_mq224pi8_775e71 600000
```

For read-only terminal inspection outside the Pi command UI:

```bash
pi-workflow inspect workflow_mq224pi8_775e71
pi-workflow inspect workflow_mq224pi8_775e71 --failures
pi-workflow inspect workflow_mq224pi8_775e71 --results
pi-workflow inspect workflow_mq224pi8_775e71 --json
```

## What workflows do

A workflow is a deterministic stage graph. The concrete user task is supplied at runtime; the workflow definition supplies the structure, role prompts, tool ceilings, output contracts, and safety policy.

Important rule: **stage order controls scheduling only**. A later plain `task` stage does not automatically receive prior output. Use `foreach.from` for dynamic fan-out and `reduce.from` for source-context fan-in.

| Stage | Use it for | Runtime shape |
|---|---|---|
| `task` | One focused step | one prompt -> one subagent |
| `parallel` | Static fan-out | fixed task list -> multiple subagents, bounded concurrency |
| `foreach` | Dynamic fan-out | read an array from prior JSON output -> one subagent task per item |
| `reduce` | Fan-in / synthesis | selected prior stage context -> one subagent |
| `transform` | Deterministic local post-processing | selected prior structured outputs -> directory-local `.mjs` helper |
| `loop` | Bounded repetition | repeat a fixed child stage subgraph until a deterministic stop condition |

A minimal workflow definition:

```json
{
  "schemaVersion": 1,
  "agent": "researcher",
  "readOnly": true,
  "tools": ["read", "grep", "find", "ls", "web_search", "fetch_content"],
  "workflow": {
    "stages": [
      {
        "id": "plan",
        "type": "task",
        "output": {
          "format": "json",
          "contract": { "requiredPaths": ["$.questions"] }
        },
        "prompt": "Plan the research questions."
      },
      {
        "id": "research",
        "type": "foreach",
        "from": { "stage": "plan", "path": "$.questions", "mode": "concat" },
        "maxConcurrency": 4,
        "each": { "prompt": "Research this question: ${item}" }
      },
      {
        "id": "summary",
        "type": "reduce",
        "from": ["plan", "research"],
        "prompt": "Use Source Stage Context to synthesize the answer."
      }
    ]
  }
}
```

## Bundled workflows

The package includes workflow definitions in [`workflows/`](./workflows/). Workflow names resolve from project `.pi/workflows/`, repository `workflows/`, bundled package workflows, and `~/.pi/agent/workflows/`; ambiguous names fail closed.

| Workflow | Shape | Use when |
|---|---|---|
| `deep-research` | task -> foreach -> reduce -> foreach -> transform -> reduce | Source-backed research, claim verification, deterministic evidence gating, citations, or follow-up suggestions. |
| `deep-review` | task -> foreach -> foreach -> reduce | Panel-style review where findings should be challenged before final synthesis. |
| `implement-loop` | loop: implement -> final check | Iterative implementation in one managed worktree until validation passes and review accepts. |
| `test-repair-loop` | loop: repair -> final test-check | Focused repair loop for failing tests or explicit validation commands. |

Other workflow shapes such as migration planning, best-of-N fixes, revise loops, and decision debates are intentionally deferred until stronger task-fit evidence exists.

## Commands

Implemented Pi command surface:

| Command | Purpose |
|---|---|
| `/workflow` or `/workflow help` | Show help. |
| `/workflow list` | List discoverable workflows. |
| `/workflow recommend "<request>"` | Score workflow catalog metadata for a request. |
| `/workflow validate <workflow-name-or-path>` | Load, validate, and compile a workflow spec. |
| `/workflow roles <workflow-name-or-path>` | Show compiled role context for a workflow. |
| `/workflow agents` | List discoverable Pi agents and their tool/model ceilings. |
| `/workflow run <workflow-name-or-path> "<task>"` | Start a workflow run for the runtime task. |
| `/workflow status [run-id]` | Summarize all runs or one run. |
| `/workflow show <run-id-or-workflow-name>` | Show run details for `workflow_*`, or raw workflow spec for a workflow name. |
| `/workflow logs <run-id> [task-id] [lines]` | Show captured task logs. Defaults to `task-1`. |
| `/workflow wait <run-id> [timeout-ms]` | Wait until a run reaches a terminal state. |

There is not currently a `/workflow` board, `/workflow view`, `/workflow continue`, or `/workflow delegate` command. Use `status`, `show`, `logs`, `wait`, and `pi-workflow inspect` for inspection.

## Create or customize workflows with `workflow-guide`

`pi-workflow` includes a `workflow-guide` skill for creating, modifying, and reviewing workflow definitions.

Use it when you want to adapt a bundled workflow or create a project-specific workflow. Project workflow definitions should be saved under:

```text
.pi/workflows/<name>.json
```

Examples:

```text
Use workflow-guide to create a workflow for weekly release readiness.
It should inspect the repo, check docs/tests risk, and produce a final checklist.
```

```text
Use workflow-guide to customize deep-review for frontend accessibility and UX review.
Save it as .pi/workflows/frontend-review.json.
```

Then validate and run:

```text
/workflow validate .pi/workflows/frontend-review.json
/workflow run frontend-review "Review the current diff for accessibility and UX regressions."
```

## Safety notes

- `/workflow` is an orchestrator, not an OS sandbox.
- Subagent workers are launched through `@agwab/pi-subagent`; inspect that package's sandbox/worktree behavior for execution isolation details.
- Agent-declared tools are the authority ceiling; workflow definitions can only narrow them.
- `readOnly: true` is enforced through tool filtering, not filesystem isolation.
- Review workflows should remain read-only unless a workflow explicitly documents managed-worktree mutation.
- Mutation-capable tasks should normally use managed worktrees in git repositories.
- In non-git workspaces, write-capable workflows with `worktreePolicy: "off"` mutate the live directory.
- No backend fallback exists: the resolved backend/strategy is fixed per run.

## Detailed docs

- [`docs/usage.md`](./docs/usage.md) — command reference, install/development notes, workflow resolution, run artifacts, authoring rules, and release checks.
- [`workflows/README.md`](./workflows/README.md) — bundled workflow notes.
- [`docs/ab-execution-results.md`](./docs/ab-execution-results.md) — local diagnostic A/B evaluation summary.
