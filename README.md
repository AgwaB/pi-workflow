# pi-workflow

**Workflow orchestration for Pi.**

[![npm](https://img.shields.io/npm/v/@agwab/pi-workflow.svg)](https://www.npmjs.com/package/@agwab/pi-workflow)

`pi-workflow` lets you write project-specific workflows and run them through Pi's focused `/workflow` command surface. It supports explicit workflow structure — stage graphs, subagent fan-out/fan-in, local support helpers, bounded loops, and resumable artifacts — on top of [`@agwab/pi-subagent`](https://www.npmjs.com/package/@agwab/pi-subagent)'s durable worker runtime.

It is intentionally a thin orchestration layer, so you can add it when you want reusable team workflows and remove it when plain Pi or direct subagent calls are enough.

npm package: [`@agwab/pi-workflow`](https://www.npmjs.com/package/@agwab/pi-workflow)

## Installation

Install the package. This downloads both the `/workflow` extension and the bundled `workflow-guide` skill:

```bash
pi install npm:@agwab/pi-workflow
```

Then reload Pi.

To update later:

```bash
pi update npm:@agwab/pi-workflow
```

Requires Node.js `>=22.19.0` on macOS or Linux. Native Windows is not supported; use WSL2.

## Quick usage

After installing and reloading Pi, call the bundled skill explicitly when you want to create or customize a workflow:

```text
/skill:workflow-guide create a workflow for weekly release readiness.
It should inspect docs, tests, recent changes, and produce a final checklist.
Save it as a reusable project workflow.
```

```text
/skill:workflow-guide adapt deep-review for frontend accessibility and UX review.
Save it as a reusable project workflow.
```

Then ask Pi to use a bundled or project workflow by name:

```text
Use the bundled deep-research workflow to research this repository and summarize the architecture tradeoffs.
```

```text
Use the bundled deep-review workflow to review the current diff from multiple angles.
```

If `/skill:workflow-guide` is not available, enable skill commands in Pi settings or use natural language: `Use workflow-guide to ...`.

`workflow-guide` is the recommended way to create or customize workflows: describe the outcome, the agents/tools you want to allow, and the review or validation steps you expect.

## What workflows do

A workflow is a deterministic stage graph. The concrete user task is supplied at runtime; the workflow definition supplies the structure, role prompts, tool ceilings, output contracts, and safety policy.

Important rule: **stage order controls scheduling only**. A later plain `task` stage does not automatically receive prior output. Use `foreach.from` for dynamic fan-out, `reduce.from` for source-context fan-in, and support `from` for local helper inputs.

Public workflow definitions have three layers:

- **Workflow layer**: stage ids, `from`, `sourcePolicy`, scheduling, and run artifacts.
- **Subagent layer**: child Pi/model worker shapes — `task`, `parallel`, `foreach`, `reduce`, and `loop`.
- **Support layer**: workflow-local helper execution via `support`; this is local Node code, not a subagent task type.

| Node | Layer | Use it for | Runtime shape |
|---|---|---|---|
| `type: "task"` | Subagent | One focused step | one prompt -> one subagent |
| `type: "parallel"` | Subagent/control | Static fan-out | fixed task list -> multiple subagents, bounded concurrency |
| `type: "foreach"` | Subagent/control | Dynamic fan-out | read an array from prior JSON output -> one subagent task per item |
| `type: "reduce"` | Subagent | Fan-in / synthesis | selected prior stage context -> one subagent |
| `type: "loop"` | Workflow/control | Bounded repetition | repeat a fixed child stage subgraph until a deterministic stop condition |
| `support` | Support | Deterministic local post-processing | selected prior structured outputs -> directory-local `.mjs` helper |

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
        "id": "normalize",
        "from": "research",
        "sourcePolicy": "partial",
        "support": {
          "uses": "./helpers/normalize.mjs",
          "options": { "dedupe": true }
        }
      },
      {
        "id": "summary",
        "type": "reduce",
        "from": ["plan", "normalize"],
        "prompt": "Use Source Stage Context to synthesize the answer."
      }
    ]
  }
}
```

### Tool allowlists and provider metadata

`tools` may be a string allowlist or a mix of strings and objects. Strings keep the existing behavior. Object entries select the same tool name while adding local provider and safety metadata for custom tools:

```json
{
  "tools": [
    "read",
    "fetch_content",
    {
      "name": "scrapling_fetch",
      "extensions": ["packages/pi-scrapling-access"],
      "classification": "read-only",
      "optional": true,
      "fallbackTools": ["fetch_content"]
    }
  ]
}
```

Agent frontmatter remains the authority ceiling: workflow, defaults, and stage `tools` can only narrow tools already declared by the selected agent. Built-in tool classifications remain authoritative; custom tools without an explicit object `classification` still require explicit review. Bundled/public workflows should avoid machine-specific local provider paths. Project-local workflows may use deliberate local package refs such as `packages/...` when they are portable within that project.

## Bundled starter workflows

The package includes a small starter set in [`workflows/`](./workflows/). These are practical defaults and authoring examples, not a comprehensive workflow catalog. Most teams should copy or create project-specific workflows under `.pi/workflows/` as their patterns settle.

Workflow names resolve from project `.pi/workflows/`, repository `workflows/`, bundled package workflows, and `~/.pi/agent/workflows/`; ambiguous names fail closed.

| Workflow | Shape | Use when |
|---|---|---|
| `deep-research` | task -> foreach -> reduce -> foreach -> support -> reduce | Source-backed research, claim verification, deterministic evidence gating, citations, or follow-up suggestions. |
| `deep-review` | task -> foreach -> support -> foreach -> support -> reduce | Multi-lens review where findings should be challenged before final synthesis. |
| `implement-loop` | loop: implement -> final check | Iterative implementation in one managed worktree until validation passes and review accepts. |
| `test-repair-loop` | loop: repair -> final test-check | Focused repair loop for failing tests or explicit validation commands. |

Additional workflow shapes are intentionally left to project-local workflows until their task fit is clear enough to bundle.

## Create or customize workflows with `workflow-guide`

`pi-workflow` includes a `workflow-guide` skill for creating, modifying, and reviewing workflow definitions.

Use it when you want to adapt a bundled starter or create a project-specific workflow. Tell Pi what kind of workflow you want, what it should check, which agents it should use, and where to save it.

Examples:

```text
/skill:workflow-guide create a backend API review workflow.
It should check concurrency, transaction safety, error handling, observability, and test risk.
Save it as a reusable project workflow.
```

```text
/skill:workflow-guide create a release readiness workflow.
It should inspect the current diff, docs, tests, package metadata, and produce a launch checklist.
```

```text
/skill:workflow-guide customize deep-review for frontend accessibility and UX review.
Save it as a reusable project workflow.
```

After the workflow is created, ask Pi to use that workflow by name for future tasks.

## Safety notes

- `/workflow` is an orchestrator, not an OS sandbox.
- Subagent workers are launched through `@agwab/pi-subagent`; inspect that package's sandbox/worktree behavior for execution isolation details.
- Agent-declared tools are the authority ceiling; workflow definitions can only narrow them.
- `readOnly: true` and custom tool classifications are permission previews/tool policy, not filesystem isolation.
- Support helpers run as local `.mjs` code inside the workflow process with bundle path containment only; they are not sandboxed and are not constrained by subagent tool allowlists.
- Review workflows should remain read-only unless a workflow explicitly documents managed-worktree mutation.
- Mutation-capable tasks should normally use managed worktrees in git repositories.
- In non-git workspaces, write-capable workflows with `worktreePolicy: "off"` mutate the live directory.
- No backend fallback exists: the resolved backend/strategy is fixed per run.

## Detailed docs

- [`docs/usage.md`](./docs/usage.md) — command reference, install/development notes, workflow resolution, run artifacts, authoring rules, and release checks.
- [`workflows/README.md`](./workflows/README.md) — bundled workflow notes.
