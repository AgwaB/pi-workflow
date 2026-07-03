# pi-workflow Usage

Detailed usage reference for the public Pi command **`/workflow`** and the `pi-workflow` CLI.

## Install

```bash
pi install npm:@agwab/pi-workflow
```

Reload Pi after installation.

This installs:

- the `/workflow` extension
- the bundled `workflow-guide` skill
- the bundled `execution-router` skill
- bundled runtime helpers, including `@agwab/pi-subagent` and `pi-web-access`

Requires Node.js `>=22.19.0`.

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
pi-workflow supervise <run-id-or-prefix> [--poll-ms N] [--max-runtime-ms N]
pi-workflow supervise --all [--poll-ms N] [--max-runtime-ms N]
```

`/workflow` with no arguments opens the read-only workflow board TUI. `/workflow <run-id>` opens the board focused on that run.

## Natural-language invocation

The extension also registers LLM-callable tools for normal chat requests:

| Tool | Purpose |
|---|---|
| `workflow_list` | List discoverable workflows when the user asks what exists or asks Pi to choose without naming one. |
| `workflow_run` | Start a run when the user explicitly asks to use/run/start a named workflow and provides a concrete task. |
| `workflow_dynamic` | Start a spec-less direct dynamic run when the user explicitly asks for dynamic workflow execution and provides a concrete task. |

Examples:

```text
Use the deep-research workflow to research this repository's architecture tradeoffs.
```

```text
Use the deep-review workflow to review the current diff for reliability and test coverage.
```

Natural-language named-workflow invocation uses the same workflow resolution roots and task-required rule as `/workflow run`. If the workflow name or concrete task is missing, Pi should ask a clarifying question instead of launching a run. The deterministic manual equivalent is:

```text
/workflow run deep-research "Research this repository's architecture tradeoffs."
```

For explicit dynamic workflow requests that should not require a workflow name or spec, Pi can use `workflow_dynamic`. The deterministic manual equivalent is:

```text
/workflow dynamic "Research this repository's architecture tradeoffs."
```

`workflow_dynamic` and `/workflow dynamic` use a built-in trusted
direct-dynamic controller and record normal `.pi/workflows/<run-id>`
artifacts/events for observability; they do not ask the user to choose,
generate, preview, approve, or save a workflow spec. Direct dynamic generated
workers validate external URL refs before completion, verifier outputs are
asked to record structured `claimSupports`, and final synthesis additionally
requires at least one ref plus an upstream source-ledger subset check. Stale,
unreachable, or newly invented final URL refs trigger the normal
workflow-output retry path. When positive verifier `claimSupports` are present,
final URL refs are restricted to those supported source locators rather than
every upstream URL.

## Bundled skills

| Skill | Use when |
|---|---|
| `execution-router` | Decide whether a task should be handled directly, by an existing workflow, by a targeted verifier/subagent, or by a new/extended workflow. |
| `workflow-guide` | Create, modify, review, validate, or explain workflow definitions after the authoring target is known. |

For reusable workflow authoring, `workflow-guide` includes validated scaffold bundles for common graph shapes. Copy a scaffold, adapt prompts/schemas/stage ids, then run `/workflow validate` on the copied spec before use.

## Commands

| Command | Purpose |
|---|---|
| `/workflow` or `/workflow <run-id>` | Open the read-only workflow board TUI. With a run id or prefix, focus that run. Falls back to text `status` output in `--print` mode or when no TUI is available. |
| `/workflow help` | Show help. |
| `/workflow list` | List workflow specs discoverable from the current project and installed package. |
| `/workflow validate <workflow-name-or-path>` | Load and compile a workflow without starting a run. Reports blocked permission previews and warnings. |
| `/workflow roles <workflow-name-or-path>` | Show the compiled role context included for each workflow role. |
| `/workflow agents` | List discoverable Pi agents, model/thinking defaults, tool ceilings, and source paths. |
| `/workflow run [--model MODEL] [--thinking LEVEL] <workflow-name-or-path> "<task>" [--detach]` | Start a named workflow run with the supplied runtime task. `--detach` spawns a standalone supervisor process after the initial scheduling pass so the run keeps progressing after this Pi session exits (log: `.pi/workflows/<run-id>/supervise.log`). Dynamic controllers and `approval: "ask"` prompts in that first pass can still run inline; later detached/headless approval blocks require an interactive `/workflow resume <run-id>`. |
| `/workflow dynamic [--model MODEL] [--thinking LEVEL] "<task>" [--detach]` | Start a spec-less direct dynamic run. The runtime uses a built-in trusted controller to plan/fan out/synthesize dynamically; no workflow name, user-selected spec, or generated spec is required. Supports the same `--model` and `--thinking` overrides as `/workflow run`. |
| `/workflow status [run-id]` | Show all workflow runs in the current project, or one run. |
| `/workflow show <run-id-or-workflow-name>` | If the ref starts with `workflow_`, show run details; otherwise show the raw workflow spec. |
| `/workflow logs <run-id> [task-id] [lines]` | Print captured logs for a workflow task. Defaults to `task-1`. |
| `/workflow wait <run-id> [timeout-ms]` | Poll until the run finishes or the optional timeout elapses. |
| `/workflow resume <run-id>` | Resume a failed, interrupted, or resumable blocked run (including dynamic approval blocked in headless mode): completed tasks are preserved; failed/interrupted/skipped or resumable blocked tasks reset to pending and reschedule. Loop workflows are not supported yet. |
| `/workflow stop <run-id>` | Stop a non-terminal run: best-effort interrupt of active subagent workers, then mark unfinished tasks `interrupted`. Completed task artifacts are preserved, and the stopped run can be restarted later with `/workflow resume` (resumed tasks start fresh sessions). |

Not implemented: `/workflow continue` and `/workflow delegate`. Use `status`, `show`, `logs`, `wait`, `stop`, `resume`, and `pi-workflow inspect` for text/CLI inspection. The standalone CLI also offers `pi-workflow supervise <run-id>|--all` to drive scheduling from outside a Pi session (unfinished failed/interrupted or resumable blocked runs within the last 7 days are announced at session start with resume hints).

### Workflow board controls

The `/workflow` board is read-only. It has four drill-down levels: runs, stages, tasks, and task detail.

| Key | Action |
|---|---|
| `Enter` / `→` | Drill into the selected run, stage, or task. |
| `b` / `Esc` / `←` | Go back one level. |
| `↑` / `↓` | Move within the current list or scroll the task artifact. |
| `[` / `]` or `p` / `n` | Move to the previous/next sibling run, stage, or task where supported. |
| `r` | Refresh run state from `.pi/workflows`. |
| `←` / `→` in task detail | Switch between task output and prompt artifacts. |
| `q` | Close the board. |

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

The runtime task is not optional. `/workflow run <workflow>` and `/workflow dynamic` without task text fail before launch.

### Opt-in fast mode

For lower-latency runs, pass `--thinking low` explicitly:

```text
/workflow run --thinking low deep-research "Research this repository and summarize the architecture tradeoffs."
/workflow dynamic --thinking low "Research this repository and summarize the architecture tradeoffs."
```

This is an opt-in fast mode. Package defaults remain conservative until a separate holdout evaluation provides enough evidence to change them. Current evidence is limited but encouraging for explicit fast runs: the 2026-07-02 `deep-research` combined gate on P1/P2/P3-style prompts resolved non-support tasks to `low`, completed selected valid runs in about 15-17 minutes, passed the strict gate 9/9, and had zero source-ref join failures across those 9 runs. Treat this as a speed option, not proof that every workflow should default to `low`.

### Run-scoped web-source cache

Prefer normalized workflow web tools in new workflows:

- `workflow_web_search` returns compact candidate cards.
- `workflow_web_fetch_source` caches one or more URLs and returns compact source cards with `sourceRef` values; pass `urls: [...]` or `sources: [{ url, title }]` to batch several fetches in one tool call.
- `workflow_web_source_read` reads narrow exact/fuzzy/term-matched evidence snippets by `sourceRef`; pass `queries: [...]` or `reads: [...]` to batch several snippets from the same source in one tool call, or `claim` + distinctive `terms` when the exact quote is unknown. Term/claim reads return candidate metadata (`matchedTerms`, `missingTerms`, `coverageRatio`) rather than a proof verdict.

The normalized cache is stored under the workflow run directory:

```text
.pi/workflows/<run-id>/web-source-cache/
```

Do not instruct agents to read that directory directly; source cards intentionally expose only opaque refs and short previews. The cache also writes an append-only index ledger plus same-URL fetch locks/negative-cache files so duplicate lookup and deterministic terminal failures can recover across parallel worker processes. Custom extension `fetch_content` providers are treated as trusted fetchers and are disabled under the default private-host policy; use the default safe fetch path or opt into trusted private-host behavior only for controlled providers. Legacy workflow tasks that still use `fetch_content` keep the older run-scoped file cache under `.pi/workflows/<run-id>/source-cache/fetch-content/`. Set `PI_WORKFLOW_FETCH_CONTENT_CACHE=0` to disable that legacy fetch cache for a run.

## Bundled workflows

`pi-workflow` ships a small official starter set, not a comprehensive workflow catalog. More official workflows are planned; create project-local or repo-shared workflows under `.pi/workflows/` or `workflows/` when your team needs patterns that are not bundled.

| Workflow | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize-input packet support + normalize + foreach verifier + audit support + final-audit packet support + compact final synthesis reduce + deterministic ledger-backed executive render | Use when you need a grounded answer or summary based on source material. |
| `deep-review` | `scout` | triage + foreach review lenses + dedup support + foreach devil's advocate + verdict-partition support + reduce | Use when you want code or design reviewed carefully from multiple angles. |
| `spec-review` | `scout` | extract spec + map implementation + inspect tests -> reduce candidates -> foreach verifier -> reduce report | Use when you want to check whether requirements, an API spec, or a contract are reflected in the implementation and tests. |
| `impact-review` | `scout` | scope/implementation/validation maps -> impact lenses -> consistency/regression/ship-readiness joins -> final synthesis | Use before merging or releasing a change to check affected areas, risks, missing tests, and missing docs. |

Bundled starters use local-first Pi agent discovery with bundled fallback
agents. Project `.pi/agents/` definitions win, then user
`~/.pi/agent/agents/`, then pi-workflow's bundled common agents (`scout`,
`researcher`). Customize the workflow when you need a different role or
stricter tool ceiling.

## Stage model

Public `schemaVersion: 1` workflows use `artifactGraph.stages` as the only authoring surface.

`fast: "on"` is intentionally unsupported in workflow specs; omit `fast` or use `"off"`/`"inherit"` where runtime defaults expose the field.

Public workflow definitions separate three layers:

- **Workflow layer**: graph/control/data-dependency fields such as `id`, `from`, `after`, `sourcePolicy`, `sourceProjection`, scheduling, and artifacts.
- **Subagent layer**: child Pi/model worker shapes: `single`, `foreach`, `reduce`, and `loop`.
- **Support layer**: local helper execution through a stage that declares a `support` object.
- **Dynamic layer**: trusted bundle-local controller code that can adaptively add official workflow tasks at runtime.

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
| `type: "dynamic"` | Dynamic/control | Runs a trusted bundle-local controller `.mjs`; generated `ctx.agent()` work is spliced into `compiled.json`/`run.json` as official workflow tasks. |
| `support: { uses }` | Support | Runs a directory-local `.mjs` helper over selected upstream `control.json` values and writes a workflow artifact bundle. |

Use `foreach.from` for static data-driven fan-out, `reduce.from` for subagent fan-in, support `from` for local helper inputs, and `type: "dynamic"` only when the workflow must decide its own child tasks at runtime. Do not rely on a later plain `single` stage to see previous stage output.

Planner-driven dynamic stages may declare `dynamic.decisionLoop` to keep adaptive behavior policy-bound in JSON. The planner emits `dynamic-decision-v1` data only; trusted controller/runtime code validates and persists decisions, maps accepted actions to generated workflow tasks, extracts state indexes, and enforces budgets, role/tool ceilings, replay invariants, and fail-closed invalid-decision behavior. Users still provide only the normal workflow task string.

### Dynamic workflow authoring

Dynamic workflows keep JSON as the source of truth while allowing trusted bundle-local JavaScript to orchestrate adaptive work. A dynamic stage looks like this:

```json
{
  "id": "adaptive",
  "type": "dynamic",
  "dynamic": {
    "uses": "./helpers/controller.mjs",
    "mode": "graph-splice",
    "permissions": { "approval": "auto" },
    "budget": { "maxAgents": 1000, "maxConcurrency": 16 }
  }
}
```

Controller/helper/nested workflow refs must be bundle-local `./...` paths. Nested workflow specs are intentionally self-contained at their own directory level: refs inside a nested spec may point to files in that nested spec's subtree, but not to parent-level shared files via `../` — put shared helpers/schemas under each nested workflow subtree or expose them through the parent controller/helper layer. Controller/helper code is trusted Node.js code for orchestration and timeout isolation, not a security sandbox.

Controller context rules:

- Generated agents are real workflow tasks: `ctx.agent({ id, agent, prompt, tools })` inserts a deterministic `stageId.id` task into `compiled.json` and `run.json`, persists a request hash in `dynamic/events.jsonl`, and replays fail-closed if the same id later changes request shape.
- On resume, controllers must re-issue previously recorded `ctx.agent`, `ctx.helper`, and `ctx.workflow` operations in the same order before issuing new operations; omitted or out-of-order replay fails closed with an explicit replay-invariant error.
- Use `ctx.parallel([() => ctx.agent(...), ...])` for dynamic fan-out; the runtime records queued sibling generation ops before the controller suspends, and non-suspension operation failures make the controller fail closed. Generated dependency cycles are rejected.
- `ctx.helper(name, input)` can call only helpers declared in `dynamic.helpers`; pure/retry-safe helpers may set `idempotent: true` so a crash after `helper.started` but before `helper.completed` can retry the helper instead of permanently failing closed.
- `ctx.workflow(name, input)` can call only nested specs declared in `dynamic.workflows`.

Dynamic outputs should be compact typed artifacts. The controller returns normal workflow sections through `{ control, analysis, refs }`; generated child agents must return the same `<control>`, `<analysis>`, `<refs>` protocol as other artifact-graph tasks. When a controller result includes `outputTasks`/`outputTaskIds` (the built-in decision loop sets this from accepted `synthesize` actions), downstream `from: "<dynamic-stage>"` reducers also receive those exported task artifacts as stable sources such as `<dynamic-stage>.output`. Runtime state is stored under `.pi/workflows/<run-id>/dynamic/`:

- `events.jsonl` — append-only decisions such as controller status, task generation, helper completions, nested workflow starts, and approvals.
- `state.json` — replayable projection/cache of controller status, generated task ids, and budget counters.
- `controller.log` — JSONL records from `ctx.log(...)`, useful for controller debugging.

Approval modes:

- `approval: "auto"` is the default.
- `approval: "ask"` uses Pi's interactive `ctx.ui.confirm` and records the approved dynamic scope, including the full task digest and run-bundle fingerprint. Approving the controller authorizes this controller's generated agents to run without later approval prompts; generated agents run non-interactively within the displayed roles/tools and budgets. Read-only generated agents use the shared workspace; mutation-capable generated agents and agents using Pi-default tools use managed worktrees. Nested workflows keep their own approval policy and may still block for approval. Pure headless scheduling fails closed with `dynamic_ui_unavailable`; missed/timed-out prompts fail closed with `dynamic_approval_timeout`. `/workflow resume <run-id>` from an interactive Pi session retries either blocked approval state.

Budgets bound controller behavior (`maxAgents`, `maxConcurrency`, `maxRuntimeMs`, `maxNestedWorkflowDepth`, `maxGraphMutations`, `maxHelperRuns`). Suspended child-agent wait time does not count as active controller runtime. `ctx.budget.remaining()` reports current headroom, including live generated-agent concurrency from the run record, and `ctx.budget.check()` returns false once any budget dimension is exhausted. `allowDynamicRoles` and `allowDynamicTools` default to enabled under the trusted-code model and are enforced when disabled: controller attempts to choose generated agent roles or override tools fail.

### DAG authoring

Top-level `artifactGraph.stages` is DAG-capable by default. A nested `type: "dag"` is a workflow/control container, not a leaf subagent task: it must contain child `stages` and should not have its own prompt. The runtime lowers public graph relationships onto the internal dependency scheduler while preserving artifact/data boundaries. Keep the authoring layers described under "Stage model" distinct when composing DAGs.

DAG rules:

- `from` is a data + order edge. Downstream artifact-graph stages receive a `workflow_artifact` manifest and digest-only inline source list; deterministic runtime decisions read upstream `control.json`.
- `after` is order-only. It accepts a string or string array, waits for those stages, and does not make their artifacts available as source data.
- `after: []` is an explicit parallel root. It opts out of the implicit previous-stage chain while documenting that the stage intentionally has no ordering dependency.
- Parse-time graph validation rejects unknown stage references, self-dependencies, duplicate stage ids, dependency cycles, unsupported output fields, and unsafe `controlSchema` paths.
- `inputPolicy.requiredReads` is fail-closed: if declared, the task must read each listed `source.artifact` via `workflow_artifact` before its final output is accepted. The runtime does not preload required artifact contents into the prompt; it exposes source refs and checks the read ledger. Direct repo `read`/`grep` calls do not satisfy this proof; the ledger proves artifact access, not semantic use. DAG container outputs use the selected child source name, for example `analysis.final.analysis` for `id: "analysis", outputFrom: "final"`.
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
| `run.json` | Canonical run record: status, task summary, task records, fanout/loop/dynamic metadata, and run timestamps. |
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

Project workflows can live in either project workflow root:

```text
.pi/workflows/<name>.json
.pi/workflows/<name>/spec.json
workflows/<name>.json
workflows/<name>/spec.json
```

Use `workflows/` for repo-committed shared workflows and `.pi/workflows/` for local/project-private workflows. Use the directory-bundle form when the workflow needs schemas, support helpers, or copied scaffold files.

`workflow-guide` ships validate-ready scaffolds under `skills/workflow-guide/scaffolds/`:

| Scaffold | Use when |
|---|---|
| `foreach-reduce` | Extract a list of work items, verify each item, then synthesize a report. |
| `support-partition` | Candidate findings need deterministic partitioning/dedup after verifier verdicts. |
| `dag-required-reads` | A nested analysis DAG must expose one child output and force downstream artifact reads. |
| `matrix-dag` | Multiple review lenses should run in parallel and then join through reducers. |
| `object-tool-fallback` | A read-only workflow needs optional custom/web extraction fallback tooling. |

Authoring checklist:

1. Start from a bundled workflow when one fits.
2. Start from a scaffold when its topology matches the requested new workflow.
3. Decide the workflow graph first: subagent stages (`single`, `foreach`, `reduce`, `loop`), `dag` containers, dynamic stages when adaptive runtime orchestration is required, and support nodes when deterministic local helper code is needed.
4. Make every data dependency explicit with `foreach.from`, `reduce.from`, support `from`, or dynamic `ctx.agent`/`ctx.helper`/`ctx.workflow` calls.
5. Keep read-only workflows read-only.
6. For write-capable workflows, choose a worktree policy and validation stage.
7. Add JSON output contracts for model-produced data that later stages depend on.
8. Run `/workflow validate <workflow-or-file>` before using the workflow.

### Tool allowlists

Workflow `tools` are still the child-worker allowlist. Entries can be strings:

```json
{ "tools": ["read", "grep", "workflow_web_search", "workflow_web_fetch_source", "workflow_web_source_read"] }
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
      "fallbackTools": ["workflow_web_fetch_source"]
    }
  ]
}
```

Scope order is agent frontmatter fallback < `defaults.tools` < stage `tools`: the most specific defined list controls the final tool names, and selected string names can inherit broader object metadata for the same tool. Agent frontmatter `tools` remain the hard ceiling, so workflow specs cannot grant tools an agent did not declare. Built-in classifications win for built-in tools. Custom tools without an explicit object `classification` stay blocked for explicit review. Avoid hardcoded machine-local paths in bundled/public workflows; project-local workflows may use local package refs intentionally when they are part of that project.

## Safety and execution model

- `/workflow` is an orchestrator, not an OS sandbox.
- Workers run through `@agwab/pi-subagent`; sandbox/worktree behavior follows that package.
- Workflow tool lists can only narrow agent-declared tool authority, even when object-form provider metadata is used.
- `readOnly: true` is a safety declaration used for capability/worktree classification; it does not isolate the filesystem or make mutation-capable tools safe.
- Write-capable workflows should use managed worktrees in git repositories.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- No backend fallback exists. The compiled backend/strategy is fixed for the run.
- External content, source files, and web pages used by workflow workers are untrusted data, not instructions.

## Web tools

New workflows should use `workflow_web_search`, `workflow_web_fetch_source`, and
`workflow_web_source_read` — tool semantics, batching forms, and the run-scoped
cache are documented under "Run-scoped web-source cache" above. The bundled
`pi-web-access` adapter remains the default compatibility provider for this
release scope.

- Legacy workflows that use `web_search`, `fetch_content`, `get_search_content`, or `code_search` still use the bundled `pi-web-access` dependency packaged with pi-workflow.
- Object-form custom tool `extensions` are merged with built-in mappings and deduplicated for the subagent launch.
- Web calls can still fail when network access, provider credentials, browser state, or quota are unavailable; research workflows should report those limits instead of guessing.
