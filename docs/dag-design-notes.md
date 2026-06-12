# DAG design notes

Status: implemented (2026-06-13). Original design reasoning is retained below for history.

## Current model

`pi-workflow` currently has a stage-first public model:

```json
{
  "workflow": {
    "stages": [
      { "id": "plan", "type": "task", "prompt": "..." },
      { "id": "review", "type": "foreach", "from": "plan", "each": { "prompt": "..." } },
      { "id": "final", "type": "reduce", "from": "review", "prompt": "..." }
    ]
  }
}
```

The compiler lowers `from` relationships into internal `dependsOn` edges. The engine then schedules ready tasks with DAG-like behavior: dependencies must finish before dependent stages run, max concurrency is enforced, failures skip dependents unless a stage's `sourcePolicy` permits partial sources, and dynamic stages such as `foreach` materialize child tasks at runtime.

This means the runtime already has an internal dependency scheduler. What is not finished is a public DAG authoring surface.

## Layering principle

Keep the layer distinction clear:

- **Workflow layer**: graph/control/data-dependency semantics (`id`, `from`, future order-only edges, scheduling, artifacts).
- **Subagent layer**: model-backed execution patterns (`task`, static `parallel`, `foreach`, `reduce`, `loop` children that launch subagents).
- **Support layer**: local helper execution through `support: { uses, options }`.

A DAG is not a leaf subagent task pattern. It is a graph/control construct.

## Should DAG be a `type`?

A `type: "dag"` can still be coherent if it is a **workflow control container**, not a leaf task. This is similar to `type: "loop"`: a loop is not a subagent pattern, but a composite workflow control node with child stages, lifecycle, and deterministic state.

Good shape:

```json
{
  "id": "analysis",
  "type": "dag",
  "stages": [
    { "id": "scan", "type": "task", "prompt": "..." },
    { "id": "review", "type": "task", "after": ["scan"], "prompt": "..." },
    { "id": "final", "type": "reduce", "from": ["scan", "review"], "prompt": "..." }
  ]
}
```

Bad/ambiguous shape:

```json
{ "id": "x", "type": "dag", "prompt": "..." }
```

A DAG node should not directly execute work. It should contain stages and define graph semantics.

## Edge semantics to preserve

Future DAG work should distinguish data edges from order-only edges:

- `from`: data/source dependency. The downstream stage can read source outputs.
- `after` or equivalent: order-only dependency. The downstream stage waits but does not receive source data.

This avoids overloading `from` as both data flow and sequencing.

## Recommended direction

1. Keep top-level `workflow.stages` DAG-capable by default.
2. Add explicit order-only edges (`after` or a similarly named field) if needed.
3. Consider `type: "dag"` only as a nested workflow/control container with child `stages`.
4. Do not revive legacy top-level `flow.type: "dag"`; reject it with migration guidance.

## Legacy cleanup

The old top-level `flow.type` topology model (`single`, `parallel`, `chain`, `dag`, `map`) predates stage-first workflows. The stage-first public model should be the authoritative authoring surface. Legacy `flow.type` bodies should fail closed with guidance to use `workflow.stages`.

## Implementation record (2026-06-13)

- **D1 — Split context from order dependencies.** `from` remains data + order and feeds Source Stage Context. `after` is order-only; when a stage uses both, scheduling waits on both sets but context is built only from `from`.
- **D2 — Validate whole graphs at parse time.** Top-level `workflow.stages` and each DAG container child graph reject unknown refs, self-dependencies, duplicate ids, and cycles before compile/run, with issue paths pointing at the offending field.
- **D3 — Preserve explicit parallel roots.** `after: []` is accepted as an explicit opt-out from the implicit previous-stage chain.
- **D4 — Lower containers statically.** `type: "dag"` containers flatten child stages into namespaced task/stage ids such as `analysis.scan.main`; `outputFrom` (or a single-sink default) maps the container id to the selected child task keys for downstream edges.
- **D5 — Defer namespace-aware loop keys.** Loop children inside DAG containers are rejected in v1. Supporting them needs namespace-aware loop materialization keys and resume/reconciliation semantics, so loops remain top-level for now.
