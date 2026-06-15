<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/logo-dark.svg">
    <img src="docs/assets/readme/logo.svg" width="160" alt="pi-workflow">
  </picture>
</p>

<h1 align="center">pi-workflow</h1>

<p align="center"><strong>Workflow orchestration for Pi.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agwab/pi-workflow"><img src="https://img.shields.io/npm/v/@agwab/pi-workflow.svg" alt="npm"></a>
</p>

`pi-workflow` lets Pi run named, repeatable multi-step workflows: research, code review, spec conformance checks, impact review, and project-specific team routines.

You choose a workflow and describe the task in natural language. `pi-workflow` coordinates the steps, passes results between them, and records the run so it can be inspected or resumed.

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

After installation, ask Pi to use a bundled or project workflow by name. Bundled workflows reference common Pi agents such as `scout` and `researcher`; create or install matching agents in your Pi environment before running them.

```text
Use the bundled deep-research workflow to research this repository and summarize the architecture tradeoffs.
```

```text
Use the bundled deep-review workflow to review the current diff from multiple angles.
```

```text
Use the spec-review workflow to compare docs/API_SPEC.md against the implementation and tests.
```

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

## Workflow architecture

A workflow is a deterministic stage graph for running one natural-language task through a reusable process.

`pi-workflow` is organized around three parts:

1. **Workflow** — the graph and run lifecycle: what stages exist, when they run, and how outputs move forward.
2. **Task** — agent-backed work: focused prompts, dynamic fan-out, fan-in synthesis, and bounded loops.
3. **Support** — deterministic local rails: helper code, validation, normalization, artifacts, and resume-friendly run state.

In short: workflows define the process, tasks ask Pi agents to do the work, and support keeps the process structured and repeatable.

A small workflow definition looks like this:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "agent": "researcher",
    "readOnly": true,
    "tools": ["read", "grep", "find", "ls"]
  },
  "artifactGraph": {
    "stages": [
      {
        "id": "plan",
        "type": "task",
        "prompt": "Put machine-readable JSON in <control> with an items array."
      },
      {
        "id": "inspect",
        "type": "foreach",
        "from": { "source": "plan", "path": "$.items" },
        "each": { "prompt": "Inspect this item: ${item}" }
      },
      {
        "id": "prepare",
        "from": "inspect",
        "sourcePolicy": "partial",
        "support": { "uses": "./helpers/prepare.mjs" }
      },
      {
        "id": "report",
        "type": "reduce",
        "from": ["plan", "prepare"],
        "prompt": "Use upstream workflow artifacts to write the final report."
      }
    ]
  }
}
```

## Supported task patterns

Workflow definitions compose a small set of task patterns and graph shapes.

| Pattern | Use it for | Runtime shape |
|---|---|---|
| `task` | One focused step | one prompt -> one subagent |
| `parallel` | Independent fixed work | graph shape: multiple known stages can run at the same time |
| `foreach` | Dynamic fan-out | JSON array from an upstream control artifact -> one subagent per item |
| `reduce` | Fan-in / synthesis | upstream workflow artifacts -> one synthesis subagent |
| `loop` | Bounded repetition | repeat child stages until a deterministic stop condition |
| `dag` | Nested graph container | child stages lowered to namespaced tasks; selected output exposed downstream |

![Core workflow stage shapes](./docs/assets/readme/stage-types.png)

`parallel` is a graph shape, not a separate `type` value. Support helpers are declared with a `support` object, not a task `type`.

## Predefined workflows

The package includes a small starter set. These are practical defaults and authoring examples, not a complete workflow catalog.

| Workflow | Use when |
|---|---|
| `deep-research` | Source-backed research, claim verification, citations, or follow-up suggestions. |
| `deep-review` | Multi-lens review where findings should be challenged before final synthesis. |
| `spec-review` | Read-only comparison of a spec/contract against implementation and tests. |
| `impact-review` | Read-only ship-impact review for changed or proposed work, especially missing tests, docs, release work, compatibility risk, and follow-up actions. |

![Deep research workflow flow](./docs/assets/readme/deep-research-flow.png)

![Deep review workflow flow](./docs/assets/readme/deep-review-flow.png)

Most teams should create project-specific workflows as their patterns settle.

## More

- [`docs/usage.md`](./docs/usage.md) — command reference, workflow resolution, run artifacts, authoring rules, and release checks.
- [`workflows/README.md`](./workflows/README.md) — bundled workflow notes.
