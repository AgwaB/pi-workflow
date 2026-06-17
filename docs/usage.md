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

`/workflow` with no arguments opens the read-only workflow board TUI. `/workflow <run-id>` opens the board focused on that run.

## Natural-language invocation

The extension also registers two LLM-callable tools for normal chat requests:

| Tool | Purpose |
|---|---|
| `workflow_list` | List discoverable workflows when the user asks what exists or asks Pi to choose without naming one. |
| `workflow_run` | Start a run when the user explicitly asks to use/run/start a named workflow and provides a concrete task. |

Examples:

```text
Use the deep-research workflow to research this repository's architecture tradeoffs.
```

```text
deep-review workflow로 현재 diff를 reliability/test coverage 관점에서 리뷰해줘.
```

Natural-language invocation uses the same workflow resolution roots and task-required rule as `/workflow run`. If the workflow name or concrete task is missing, Pi should ask a clarifying question instead of launching a run. The deterministic manual equivalent is:

```text
/workflow run deep-research "Research this repository's architecture tradeoffs."
```

## Commands

| Command | Purpose |
|---|---|
| `/workflow` or `/workflow <run-id>` | Open the read-only workflow board TUI. With a run id or prefix, focus that run. Falls back to text `status` output in `--print` mode or when no TUI is available. |
| `/workflow help` | Show help. |
| `/workflow list` | List workflow specs discoverable from the current project and installed package. |
| `/workflow validate <workflow-name-or-path>` | Load and compile a workflow without starting a run. Reports blocked permission previews and warnings. |
| `/workflow roles <workflow-name-or-path>` | Show the compiled role context included for each workflow role. |
| `/workflow agents` | List discoverable Pi agents, model/thinking defaults, tool ceilings, and source paths. |
| `/workflow run <workflow-name-or-path> "<task>" [--detach]` | Start a workflow run with the supplied runtime task. `--detach` spawns a standalone supervisor process so the run keeps progressing after this Pi session exits (log: `.pi/workflows/<run-id>/supervise.log`). |
| `/workflow status [run-id]` | Show all workflow runs in the current project, or one run. |
| `/workflow show <run-id-or-workflow-name>` | If the ref starts with `workflow_`, show run details; otherwise show the raw workflow spec. |
| `/workflow logs <run-id> [task-id] [lines]` | Print captured logs for a workflow task. Defaults to `task-1`. |
| `/workflow wait <run-id> [timeout-ms]` | Poll until the run finishes or the optional timeout elapses. |
| `/workflow resume <run-id>` | Resume a failed or interrupted run: completed tasks are preserved; failed/interrupted/skipped tasks reset to pending and reschedule. Loop workflows are not supported yet. |

Not implemented: `/workflow continue` and `/workflow delegate`. Use `status`, `show`, `logs`, `wait`, `resume`, and `pi-workflow inspect` for text/CLI inspection. The standalone CLI also offers `pi-workflow supervise <run-id>|--all` to drive scheduling from outside a Pi session (unfinished failed/interrupted runs within the last 7 days are announced at session start with resume hints).

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

Workflow specs are JSON-only. Use `.json` for direct path refs, named discovery, and bundle `spec.json` files; `.yaml` and `.yml` workflow specs are not supported.

A workflow can be a direct spec path, but bundled reusable workflows should use directory bundles:

```text
workflows/deep-review/
  spec.json

workflows/deep-research/
  spec.json
  helpers/
    claim-evidence-gate.mjs
```

Bundle names resolve from the directory name. If two specs expose the same name, resolution fails closed as ambiguous.

## Running workflows

Recommended workflow selection flow:

```text
/workflow list
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
| `impact-review` | `scout` | scope/implementation/validation maps -> impact lenses -> consistency/regression/ship-readiness joins -> final synthesis | Read-only ship-impact review for changed or proposed work, especially missing tests, docs, release work, compatibility risk, and follow-up actions. |

Bundled starters use normal Pi agent discovery. Ensure the named agents exist in `~/.pi/agent/agents/` or project `.pi/agents/`, or customize the workflow with agents that exist in your environment.

## Stage model

Public `schemaVersion: 1` workflows use `artifactGraph.stages` as the only authoring surface.

`fast: "on"` is intentionally unsupported in workflow specs; omit `fast` or use `"off"`/`"inherit"` where runtime defaults expose the field.

Public workflow definitions separate three layers:

- **Workflow layer**: graph/control/data-dependency fields such as `id`, `from`, `after`, `sourcePolicy`, `sourceProjection`, scheduling, and artifacts.
- **Subagent layer**: child Pi/model worker shapes: `single`, `foreach`, `reduce`, and `loop`.
- **Support layer**: local helper execution through a stage that declares a `support` object.

Every subagent stage writes artifact bundles:

- `control.json` — strict machine-readable control-plane JSON. Deterministic workflow decisions read this file only.
- `analysis.md` — prose reasoning/evidence for humans and downstream readers.
- `refs.json` — structured evidence pointers.
- `raw.md` — original final answer.

| Node | Layer | Data behavior |
|---|---|---|
| `type: "single"` | Subagent | One focused subagent prompt. |
| `type: "foreach"` | Subagent/control | Reads an array from an upstream `control.json` simple dot path and materializes one task per item. |
| `type: "reduce"` | Subagent | Fan-in over upstream artifact handles and optional `sourceProjection` inline control snippets. |
| `type: "loop"` | Workflow/control | Repeats fixed child stages until deterministic `until`, `maxRounds`, or no-progress stop. Loop conditions read child `control.json`. |
| `type: "dag"` | Workflow/control | Composite container; lowers child stages to namespaced tasks and exposes an `outputFrom` child downstream. |
| `support: { uses }` | Support | Runs a directory-local `.mjs` helper over selected upstream `control.json` values and writes a workflow artifact bundle. |

Use `foreach.from` for dynamic fan-out, `reduce.from` for subagent fan-in, and support `from` for local helper inputs. Do not rely on a later plain `single` stage to see previous stage output.

### DAG authoring

Top-level `artifactGraph.stages` is DAG-capable by default. A nested `type: "dag"` is a workflow/control container, not a leaf subagent task: it must contain child `stages` and should not have its own prompt. The runtime lowers public graph relationships onto the internal dependency scheduler while preserving artifact/data boundaries.

Keep these layers distinct:

- **Workflow layer**: graph/control/data-dependency semantics such as `id`, `from`, `after`, `sourcePolicy`, `sourceProjection`, scheduling, and artifacts.
- **Subagent layer**: model-backed execution patterns such as `single`, `foreach`, `reduce`, and loop child stages.
- **Support layer**: deterministic local helper execution through `support: { uses, options }`.

DAG rules:

- `from` is a data + order edge. Downstream artifact-graph stages receive a `workflow_artifact` manifest and digest-only inline source list; deterministic runtime decisions read upstream `control.json`.
- `after` is order-only. It accepts a string or string array, waits for those stages, and does not make their artifacts available as source data.
- `after: []` is an explicit parallel root. It opts out of the implicit previous-stage chain while documenting that the stage intentionally has no ordering dependency.
- Parse-time graph validation rejects unknown stage references, self-dependencies, duplicate stage ids, dependency cycles, unsupported output fields, and unsafe `controlSchema` paths.
- `inputPolicy.requiredReads` is fail-closed: if declared, the task must read each listed `source.artifact` via `workflow_artifact` before its final output is accepted. Direct repo `read`/`grep` calls do not satisfy this proof; the ledger proves artifact access, not semantic use. DAG container outputs use the selected child source name, for example `analysis.final.analysis` for `id: "analysis", outputFrom: "final"`.
- `sourceProjection.include` can inline small selected simple dot paths from upstream `control.json` (for example `$.digest` or `$.items`); full artifacts remain available through `workflow_artifact`.
- A `type: "dag"` stage may contain `single`, `foreach`, `reduce`, support nodes, or nested `dag` stages. Loops are top-level workflow/control stages in v1. Child `from`/`after` references resolve only to siblings inside the same container.
- `outputFrom` names the child whose task keys represent the container for downstream `from: "containerId"` edges. If omitted, exactly one sink child defaults as the output; multiple sink children require explicit `outputFrom`.

Example diamond plus a DAG container consumed downstream:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "agent": "scout",
    "readOnly": true,
    "tools": ["read", "grep", "find", "ls"]
  },
  "artifactGraph": {
    "stages": [
      {
        "id": "plan",
        "type": "single",
        "prompt": "Put machine-readable JSON in <control> with an items array."
      },
      {
        "id": "scan",
        "type": "foreach",
        "from": { "source": "plan", "path": "$.items" },
        "each": { "prompt": "Scan this item: ${item}" }
      },
      {
        "id": "review",
        "type": "single",
        "after": "plan",
        "prompt": "Run an independent review after planning finishes."
      },
      {
        "id": "merge",
        "type": "reduce",
        "from": ["scan", "review"],
        "sourceProjection": { "include": ["$.digest"] },
        "prompt": "Merge both branch outputs."
      },
      {
        "id": "analysis",
        "type": "dag",
        "from": "merge",
        "outputFrom": "final",
        "stages": [
          { "id": "scan", "type": "single", "prompt": "Scan the merged findings." },
          { "id": "review", "type": "single", "after": "scan", "prompt": "Review after the scan without scan output context." },
          { "id": "final", "type": "reduce", "from": ["scan", "review"], "prompt": "Summarize the analysis children." }
        ]
      },
      {
        "id": "report",
        "type": "reduce",
        "from": "analysis",
        "inputPolicy": { "requiredReads": ["analysis.final.analysis"], "enforcement": "fail" },
        "prompt": "Write the final report using analysis artifacts."
      }
    ]
  }
}
```

## Output contracts

Artifact-graph subagent stages must return the workflow output section protocol:

```text
<control>{"schema":"stage-control-v1","digest":"..."}</control>
<analysis>Detailed reasoning and evidence discussion.</analysis>
<refs>[]</refs>
```

The engine parses that output strictly: exactly one `<control>`, then one `<analysis>`, then one `<refs>` section, with no prose outside the tags. It writes `control.json`, `analysis.md`, `refs.json`, and `raw.md`, and retries/fails invalid output within the stage retry budget. `control.digest` is required and bounded by `output.maxDigestChars`.

Use workflow-local JSON Schema files when the control plane needs stronger validation:

```json
{
  "output": {
    "controlSchema": "./schemas/questions-control.schema.json",
    "analysis": { "required": true },
    "refs": { "required": true }
  }
}
```

The built-in validator supports the subset used by bundled workflows: `type`, `required`, `properties`, `items`, `enum`, `const`, length/item/number bounds, `additionalProperties`, and simple `allOf`/`anyOf`/`oneOf`. Unsupported keywords such as `$ref`, `$defs`, `definitions`, and `pattern` are rejected when the workflow is loaded.

## Support helpers

A support node runs local helper code inline instead of launching a subagent. It is declared by adding a `support` object; it does not use a separate `type` value:

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
  return { schema: "helper-output-v1", digest: "...", value: { /* control data */ } };
}
```

For artifact-graph workflows, `sources` contains upstream `control.json` values keyed by stable source names. The helper result is normalized into a workflow artifact bundle, so downstream deterministic readers still consume `control.json`.

Helper refs must start with `./`, end in `.mjs`, and stay inside the workflow bundle directory. This is path containment, not a security sandbox: helper code runs unsandboxed inside the workflow process, has Node.js process permissions, is not constrained by subagent tool allowlists, and should only be bundled from trusted repository code. Legacy `type: "transform"` specs are rejected with a migration error; move the helper ref to `support.uses` and options to `support.options`.

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

Loop child stages run strictly in listed order. Nested `loop`, `foreach`, `dag`, and support children are rejected in v1. There is no `parallel` stage type; model parallel branches as multiple roots or with `after: []`.

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
| `tasks/<task-id>/control.json` | Machine-readable control artifact for artifact-graph tasks. |
| `tasks/<task-id>/analysis.md` | Human-readable reasoning/evidence artifact. |
| `tasks/<task-id>/refs.json` | Structured evidence pointers. |
| `tasks/<task-id>/raw.md` | Original final answer before section extraction. |
| `tasks/<task-id>/read-ledger.jsonl` | `workflow_artifact` read proof used by `requiredReads`. |
| `tasks/<task-id>/source-manifest.json` | Upstream artifact manifest visible to the task. |
| `tasks/<task-id>/output.log` | Captured worker output copied from the subagent attempt. |
| `tasks/<task-id>/stderr.log` | Captured worker stderr. |
| `tasks/<task-id>/result.json` | Structured task result envelope and artifact pointers. |

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
2. Decide the workflow graph first: subagent stages (`single`, `foreach`, `reduce`, `loop`), `dag` containers, and support nodes when deterministic local helper code is needed.
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
npm run release:check
npm publish --dry-run
```

`npm run release:check` runs unit tests, e2e consumer/CLI smoke, typecheck, build, and `npm run pack:dry`.

The dry-run package should not include local/internal files, test output, runtime state, or machine-specific paths.
