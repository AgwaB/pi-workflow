# pi-workflow

**Workflow orchestration for Pi.**

[![npm](https://img.shields.io/npm/v/@agwab/pi-workflow.svg)](https://www.npmjs.com/package/@agwab/pi-workflow)

`pi-workflow` lets Pi run repeatable multi-agent workflows: research, review, implementation loops, test repair, and project-specific team routines.

It is a thin orchestration layer on top of [`@agwab/pi-subagent`](https://www.npmjs.com/package/@agwab/pi-subagent). A workflow defines stages, agents, tools, output contracts, support helpers, and safety policy. The concrete user task is still supplied at runtime in natural language.

## Installation

Install the package:

```bash
pi install npm:@agwab/pi-workflow
```

Then reload Pi.

This installs both:

- the `/workflow` extension
- the bundled `workflow-guide` skill

To update later:

```bash
pi update npm:@agwab/pi-workflow
```

Requires Node.js `>=22.19.0` on macOS or Linux. Native Windows is not supported; use WSL2.

## Usage: ask naturally

After installation, ask Pi to use a bundled or project workflow by name:

```text
Use the bundled deep-research workflow to research this repository and summarize the architecture tradeoffs.
```

```text
Use the bundled deep-review workflow to review the current diff from multiple angles.
```

```text
Use the test-repair-loop workflow to fix the failing validation command I just ran.
```

Bundled starter workflows:

| Workflow | Use when |
|---|---|
| `deep-research` | Source-backed research, claim verification, citations, or follow-up suggestions. |
| `deep-review` | Multi-lens review where findings should be challenged before final synthesis. |
| `implement-loop` | Iterative implementation in one managed worktree until validation passes and review accepts. |
| `test-repair-loop` | Focused repair loop for failing tests or explicit validation commands. |

These are starter workflows, not a complete catalog. Most teams should create project-specific workflows as their patterns settle.

## Usage: create your own workflows

Use the bundled `workflow-guide` skill when you want to create, adapt, or review a workflow definition:

```text
/skill:workflow-guide create a workflow for weekly release readiness.
It should inspect docs, tests, recent changes, package metadata, and produce a final checklist.
Save it as a reusable project workflow.
```

```text
/skill:workflow-guide customize deep-review for frontend accessibility and UX review.
Save it as a reusable project workflow.
```

```text
/skill:workflow-guide create a backend API review workflow.
It should check concurrency, transaction safety, error handling, observability, and test risk.
```

If `/skill:workflow-guide` is not available, enable skill commands in Pi settings or ask naturally:

```text
Use workflow-guide to create a reusable workflow for release readiness.
```

Project workflows usually live under:

```text
.pi/workflows/
```

Workflow names resolve from project `.pi/workflows/`, repository `workflows/`, bundled package workflows, and `~/.pi/agent/workflows/`. Ambiguous names fail closed.

## Workflow architecture

`pi-workflow` has three layers:

1. **Workflow** — the deterministic graph: stage ids, `from` links, scheduling, loop bounds, run state, artifacts, and resume behavior.
2. **Task** — the subagent execution patterns used inside the graph: one worker, fixed fan-out, dynamic fan-out, fan-in synthesis, or bounded loops.
3. **Support** — local deterministic helper rails around subagent work: output contracts, Source Stage Context, support helpers, tool ceilings, worktrees, logs, and artifacts.

### 1. Workflow layer

A workflow is a deterministic stage graph. It decides what work exists, when each stage can run, and what prior stage context is available.

Important rule:

> Stage order controls scheduling; `from` controls data flow.

A later plain `task` does not automatically receive prior output. Use `foreach.from`, `reduce.from`, or support `from` when a stage needs structured output from earlier stages.

### 2. Task layer: subagent execution patterns

Most workflow stages launch one or more Pi subagents through `@agwab/pi-subagent`.

![Core workflow stage shapes](./docs/assets/readme/stage-types.png)

_Core subagent-backed stage shapes. `loop` and support nodes are described separately._

| Stage | Use it for | Runtime shape |
|---|---|---|
| `task` | One focused step | one prompt → one subagent |
| `parallel` | Static fan-out | fixed task list → multiple subagents, bounded concurrency |
| `foreach` | Dynamic fan-out | JSON array from prior output → one subagent task per item |
| `reduce` | Fan-in / synthesis | selected Source Stage Context → one subagent |
| `loop` | Bounded repetition | repeat a fixed child stage subgraph until a deterministic stop condition |

Example starter shapes:

![Deep research workflow flow](./docs/assets/readme/deep-research-flow.png)

![Deep review workflow flow](./docs/assets/readme/deep-review-flow.png)

### 3. Support layer

Support nodes and policies keep workflow runs deterministic and reviewable. They are not subagent tasks.

Support includes:

- output contracts and JSON validation
- output retry instructions when JSON is invalid
- Source Stage Context packaging and size caps
- directory-local `.mjs` support helpers
- tool allowlists and object-form tool metadata
- managed worktree policy for mutation-capable workflows
- run logs, artifacts, telemetry, and resume state

Support helpers run inside the workflow process, not in a subagent sandbox. Helper refs must stay inside the workflow bundle directory.

## Safety notes

- `/workflow` is an orchestrator, not an OS sandbox.
- Workers run through `@agwab/pi-subagent`; sandbox/worktree behavior follows that package.
- Agent-declared tools are the authority ceiling; workflow definitions can only narrow them.
- `readOnly: true` and custom tool classifications are permission previews/tool policy, not filesystem isolation.
- Support helpers run as local `.mjs` code inside the workflow process with bundle path containment only; they are not sandboxed and are not constrained by subagent tool allowlists.
- Review workflows should remain read-only unless a workflow explicitly documents managed-worktree mutation.
- Mutation-capable workflows should normally use managed worktrees in git repositories.
- In non-git workspaces, write-capable workflows with `worktreePolicy: "off"` mutate the live directory.
- No backend fallback exists: the resolved backend/strategy is fixed per run.

## More

- [`docs/usage.md`](./docs/usage.md) — command reference, workflow resolution, run artifacts, authoring rules, and release checks.
- [`workflows/README.md`](./workflows/README.md) — bundled workflow notes.
