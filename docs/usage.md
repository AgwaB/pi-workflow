# pi-workflow Usage

Detailed usage reference for the public Pi command **`/workflow`** and the `pi-workflow` CLI.

## Install

```bash
pi install npm:@agwab/pi-workflow
```

Reload Pi after installation.

Requires Node.js `>=22.19.0`. The package depends on `@agwab/pi-subagent`, which Pi installs through npm package dependencies.

For local development, install the checkout as a package source:

```bash
pi install /absolute/path/to/pi-workflow
```

You can also test for a single run with Pi's package/extension loading options, but a normal `pi install` mirrors the intended release path.

## Command surface

Pi command:

```text
/workflow
```

Terminal CLI:

```bash
pi-workflow inspect <run-id-or-prefix> [--failures] [--results] [--json]
```

`/workflow` with no arguments displays help. It does not currently open a board UI.

## Commands

| Command | Purpose |
|---|---|
| `/workflow` or `/workflow help` | Show help. |
| `/workflow list` | List workflow specs discoverable from the current project and installed package. |
| `/workflow recommend "<request>"` | Score workflow catalog metadata against a natural-language request. This is advisory; run remains explicit. |
| `/workflow validate <workflow-name-or-path>` | Load and compile a workflow without starting a run. Reports blocked permission previews and warnings. |
| `/workflow roles <workflow-name-or-path>` | Show the compiled role context included for each workflow role. |
| `/workflow agents` | List discoverable Pi agents, model/thinking defaults, tool ceilings, and source paths. |
| `/workflow run <workflow-name-or-path> "<task>" [--detach]` | Start a workflow run with the supplied runtime task. `--detach` spawns a standalone supervisor process so the run keeps progressing after this Pi session exits (log: `.pi/workflows/<run-id>/supervise.log`). |
| `/workflow status [run-id]` | Show all workflow runs in the current project, or one run. |
| `/workflow show <run-id-or-workflow-name>` | If the ref starts with `workflow_`, show run details; otherwise show the raw workflow spec. |
| `/workflow logs <run-id> [task-id] [lines]` | Print captured logs for a workflow task. Defaults to `task-1`. |
| `/workflow wait <run-id> [timeout-ms]` | Poll until the run finishes or the optional timeout elapses. |
| `/workflow resume <run-id>` | Resume a failed or interrupted run: completed tasks are preserved; failed/interrupted/skipped tasks reset to pending and reschedule. Loop workflows are not supported yet. |

Not implemented: `/workflow view`, `/workflow continue`, `/workflow delegate`, and a `/workflow` board. Use `status`, `show`, `logs`, `wait`, `resume`, and `pi-workflow inspect` instead. The standalone CLI also offers `pi-workflow supervise <run-id>|--all` to drive scheduling from outside a Pi session (unfinished failed/interrupted runs within the last 7 days are announced at session start with resume hints).

## Workflow resolution

A workflow ref can be either a path or a name.

Path refs:

```text
/workflow validate .pi/workflows/release-readiness.json
/workflow run ./workflows/my-workflow.json "Do the task."
```

Name refs are resolved from these roots:

1. `<cwd>/.pi/workflows/`
2. `<cwd>/workflows/`
3. bundled package `workflows/`
4. `~/.pi/agent/workflows/`

Supported spec files: `.json`, `.yaml`, `.yml`.

A workflow can be a flat file:

```text
workflows/test-repair-loop.json
```

or a bundle:

```text
workflows/deep-review/
  spec.json

workflows/deep-research/
  spec.json
  templates.json
  helpers/
    claim-evidence-gate.mjs
```

Bundle names resolve from the directory name. If a flat file and a bundle expose the same name, resolution fails closed as ambiguous.

## Running workflows

Recommended workflow selection flow:

```text
/workflow list
/workflow recommend "review this diff for security, reliability, and tests"
/workflow validate deep-review
/workflow run deep-review "Review the current diff for security, reliability, and test coverage."
```

A run prints a `workflow_*` id. Use that id for follow-up commands:

```text
/workflow status workflow_mq224pi8_775e71
/workflow wait workflow_mq224pi8_775e71 600000
/workflow show workflow_mq224pi8_775e71
/workflow logs workflow_mq224pi8_775e71 task-1 120
```

The runtime task is not optional. `/workflow run <workflow>` without task text fails before launch.

## Bundled starter workflows

`pi-workflow` ships a small starter set, not a comprehensive workflow catalog. Treat these as practical defaults and authoring examples; create project-local workflows under `.pi/workflows/` when your team needs patterns that are not bundled.

| Workflow | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize + foreach verifier + audit support + final reduce | Research needs source-backed claims, dynamic breadth/depth, independent verification, deterministic evidence gating, or citations. |
| `deep-review` | `scout` | triage + foreach review lenses + dedup support + foreach devil's advocate + verdict-partition support + reduce | Thorough multi-lens review where findings should be independently challenged before synthesis. |
| `spec-review` | `scout` | extract spec + map implementation + inspect tests -> reduce candidates -> foreach verifier -> reduce report | Read-only spec/contract conformance review against implementation and tests. |
| `implement-loop` | `delegate`, `scout` | loop: implement -> final check | Iterative implementation in one managed worktree until validation passes and review accepts, or max/no-progress stops. |
| `test-repair-loop` | `delegate`, `scout` | loop: repair -> final test-check | Focused repair loop for failing tests or explicit validation commands. |

Bundled starters use normal Pi agent discovery. Ensure the named agents exist in `~/.pi/agent/agents/` or project `.pi/agents/`, or customize the workflow with agents that exist in your environment.

## Stage model

Stage-first workflows are DAG-capable stage lists. A stage with no `from` or `after` keeps the historical implicit chain from the previous stage, but stage order does not pass data by itself. Use explicit edges when a stage needs prior output or only needs to wait.

Public workflow definitions separate three layers:

- **Workflow layer**: graph/control/data-dependency fields such as `id`, `from`, `after`, `sourcePolicy`, scheduling, and artifacts.
- **Subagent layer**: child Pi/model worker shapes: `task`, `parallel`, `foreach`, `reduce`, and `loop`.
- **Support layer**: local helper execution through a `support` object. Support is not a subagent task type.

| Node | Layer | Data behavior |
|---|---|---|
| `type: "task"` | Subagent | Receives only its compiled prompt and runtime task injection unless it has explicit source edges. |
| `type: "parallel"` | Subagent/control | Static fixed fan-out. |
| `type: "foreach"` | Subagent/control | Reads an array from `from.stage` + JSON path and materializes one task per item. |
| `type: "reduce"` | Subagent | Receives bounded Source Stage Context from `from` stages. |
| `type: "loop"` | Workflow/control | Repeats fixed child stages until deterministic `until`, `maxRounds`, or no-progress stop. |
| `type: "dag"` | Workflow/control | Composite container; lowers child stages to namespaced tasks and exposes an `outputFrom` child downstream. |
| `support` | Support | Runs a directory-local `.mjs` helper over selected source outputs. |

Use `foreach.from` for dynamic fan-out, `reduce.from` for subagent fan-in, and support `from` for local helper inputs. Do not rely on a later plain `task` to see previous stage output.

Legacy top-level `flow.type` bodies are rejected. Author new workflows with `workflow.stages`; do not revive the old `flow.type: "dag"` surface.

### DAG authoring

The implemented DAG surface is stage-first:

- `from` is a data + order edge. The downstream stage waits for source tasks and subagent stages receive a bounded `# Source Stage Context` packet; support helpers receive selected source outputs through their helper input.
- `after` is order-only. It accepts a string or string array, waits for those stages, and does not add their outputs to Source Stage Context. A stage can combine `from` and `after`; only `from` sources are injected as data.
- `after: []` is an explicit parallel root. It opts out of the implicit previous-stage chain while documenting that the stage intentionally has no ordering dependency.
- Parse-time graph validation rejects unknown stage references, self-dependencies, duplicate stage ids, and dependency cycles with path-precise issues. Top-level stages are validated as one graph; each `type: "dag"` container is validated as its own sibling-scoped graph.
- A `type: "dag"` stage is a composite workflow/control container. Children may be `task`, `foreach`, `reduce`, support nodes, or nested `dag` stages. Child `from`/`after` references resolve only to siblings inside the same container.
- A DAG container's runtime children are statically flattened with namespaced ids such as `analysis.scan.main`. Root children inherit the container's external dependencies; their source context follows the container's `from` edges.
- `outputFrom` names the child whose task keys represent the container for downstream `from: "containerId"` edges. If omitted, exactly one sink child defaults as the output; multiple sink children require explicit `outputFrom`.
- Container `sourcePolicy` and `maxConcurrency` act as defaults for children that do not set their own values.
- Loop children inside DAG containers are rejected in v1; namespace-aware loop keys inside DAG containers are deferred.

Example diamond plus a DAG container consumed downstream:

```json
{
  "schemaVersion": 1,
  "agent": "scout",
  "workflow": {
    "stages": [
      {
        "id": "plan",
        "type": "task",
        "output": { "format": "json" },
        "prompt": "Plan the review."
      },
      {
        "id": "scan",
        "type": "task",
        "from": "plan",
        "output": { "format": "json" },
        "prompt": "Scan using the plan context."
      },
      {
        "id": "review",
        "type": "task",
        "after": "plan",
        "output": { "format": "json" },
        "prompt": "Run an independent review after planning finishes."
      },
      {
        "id": "merge",
        "type": "reduce",
        "from": ["scan", "review"],
        "output": { "format": "json" },
        "prompt": "Merge both branch outputs."
      },
      {
        "id": "analysis",
        "type": "dag",
        "from": "merge",
        "outputFrom": "final",
        "stages": [
          {
            "id": "scan",
            "type": "task",
            "output": { "format": "json" },
            "prompt": "Scan the merged findings."
          },
          {
            "id": "review",
            "type": "task",
            "after": "scan",
            "prompt": "Review after the scan without scan output context."
          },
          {
            "id": "final",
            "type": "reduce",
            "from": ["scan", "review"],
            "prompt": "Summarize the analysis children."
          }
        ]
      },
      {
        "id": "report",
        "type": "reduce",
        "from": "analysis",
        "prompt": "Write the final report using analysis.final output."
      }
    ]
  }
}
```

## Output contracts

JSON-output stages can declare output contracts. The engine extracts JSON from model output, validates required paths/keys and basic caps, and retries invalid output up to the workflow's retry policy.

Use:

```json
{
  "output": {
    "format": "json",
    "contract": { "requiredPaths": ["$.questions"] }
  }
}
```

`output.template` and `output.templateRef` are prompt-shape hints; contracts are the validation authority.

## Support helpers

A support node runs local helper code inline instead of launching a subagent:

```json
{
  "id": "audit-claims",
  "from": "verify-claims",
  "sourcePolicy": "partial",
  "support": {
    "uses": "./helpers/claim-evidence-gate.mjs",
    "options": { "requireFetchedEvidenceForVerified": true }
  }
}
```

Helper API:

```js
export default async function helper({ sources, options, context }) {
  return { /* structured output */ };
}
```

Helper refs must start with `./`, end in `.mjs`, and stay inside the workflow bundle directory. This is path containment, not a security sandbox; helper code still runs inside the workflow process and is not constrained by subagent tool allowlists. Legacy `type: "transform"` specs are rejected with a migration error; move the helper ref to `support.uses` and options to `support.options`.

## Loop behavior

A `loop` stage repeats a fixed child stage subgraph once per round.

Required loop fields:

- `id`
- `maxRounds`
- `until`
- at least two child `stages`

Child stage ids are materialized as deterministic runtime ids such as:

```text
fix-loop.r01.implement
fix-loop.r01.check
fix-loop.r02.implement
fix-loop.r02.check
```

Loop child stages run strictly in listed order. Nested `loop`, `foreach`, `parallel`, and support children are rejected in v1.

A loop stops when:

- `until` evaluates true,
- `maxRounds` is exhausted,
- no-progress detection fires,
- or a blocking failure prevents scheduling.

There is no auto-merge. Managed worktree output is recorded for human review.

## Run artifacts

Workflow state is file-based under:

```text
.pi/workflows/<run-id>/
```

Important files:

| File | Purpose |
|---|---|
| `run.json` | Canonical run record: status, tasks, stages, telemetry, result summary. |
| `compiled.json` | Compiled workflow snapshot. |
| `spec.json` | Workflow spec snapshot used by the run. |
| `tasks/<task-id>/task.md` | Compiled task prompt. |
| `tasks/<task-id>/system-prompt.md` | Compiled system prompt. |
| `tasks/<task-id>/output.log` | Captured worker output. |
| `tasks/<task-id>/stderr.log` | Captured worker stderr. |
| `tasks/<task-id>/result.json` | Structured task result when available. |

Subagent worker artifacts are stored under `.pi/workflow-subagents/` by default and are referenced from the workflow run record.

## CLI inspect

The terminal CLI reads local `.pi/workflows` run records without launching Pi commands:

```bash
pi-workflow inspect workflow_mq224pi8_775e71
pi-workflow inspect workflow_mq224pi8_775e71 --failures
pi-workflow inspect workflow_mq224pi8_775e71 --results
pi-workflow inspect workflow_mq224pi8_775e71 --json
```

`inspect` accepts a full run id or an unambiguous prefix.

## Authoring workflows

Use the bundled `workflow-guide` skill when creating or reviewing reusable workflows.

Project workflows should live in:

```text
.pi/workflows/<name>.json
```

Authoring checklist:

1. Start from a bundled workflow when one fits.
2. Decide the workflow graph first: subagent stages (`task`, `parallel`, `foreach`, `reduce`, `loop`) plus support nodes when deterministic local helper code is needed.
3. Make every data dependency explicit with `foreach.from`, `reduce.from`, or support `from`.
4. Keep read-only workflows read-only.
5. For write-capable workflows, choose a worktree policy and validation stage.
6. Add JSON output contracts for model-produced data that later stages depend on.
7. Run `/workflow validate <workflow-or-file>` before using the workflow.

### Tool allowlists

Workflow `tools` are still the child-worker allowlist. Entries can be strings:

```json
{ "tools": ["read", "grep", "fetch_content"] }
```

or object specs for custom/local providers:

```json
{
  "tools": [
    "read",
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

Scope order is workflow-level `tools` < `defaults.tools` < stage `tools`; the narrowest defined list controls the final tool names, and selected string names can inherit broader object metadata. Agent frontmatter `tools` remain the hard ceiling, so workflow specs cannot grant tools an agent did not declare. Built-in classifications win for built-in tools. Custom tools without an explicit object `classification` stay blocked for explicit review. Avoid hardcoded machine-local paths in bundled/public workflows; project-local workflows may use local package refs intentionally when they are part of that project.

## Safety and execution model

- `/workflow` is an orchestrator, not an OS sandbox.
- Workers run through `@agwab/pi-subagent`; sandbox/worktree behavior follows that package.
- Workflow tool lists can only narrow agent-declared tool authority, even when object-form provider metadata is used.
- `readOnly: true` filters tools; it does not isolate the filesystem.
- Write-capable workflows should use managed worktrees in git repositories.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- No backend fallback exists. The compiled backend/strategy is fixed for the run.
- External content, source files, and web pages used by workflow workers are untrusted data, not instructions.

## Web tools

Workflows that use `web_search`, `fetch_content`, `get_search_content`, or `code_search` require Pi web access tooling. The bundled worker launcher enables the public `npm:pi-web-access` package for those tools. Object-form custom tool `extensions` are merged with this built-in mapping and deduplicated for the subagent launch. If a custom workflow references a tool that is not available in your Pi setup, customize the workflow tool list and prompts, then validate the custom workflow before running it.

## Release checks

This repository follows the same release shape as `@agwab/pi-subagent`:

- scoped npm package name: `@agwab/pi-workflow`
- `private: false`
- `publishConfig.access: public`
- Pi package manifest in `package.json`
- README + `docs/usage.md`

Before publishing, maintainers should run the public checks and inspect the package surface:

```bash
npm run typecheck
npm test
npm run e2e
npm pack --dry-run --json
npm publish --dry-run
```

The dry-run package should not include local/internal files, test output, runtime state, or machine-specific paths.
