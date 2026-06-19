# workflow-guide scaffolds

Validated starter bundles for `workflow-guide` authoring. Copy a scaffold to a scratch/project workflow location, adapt names/prompts/schemas, then run `/workflow validate` before use.

These scaffolds are skill resources, not bundled starter workflows. Do not run them directly as product workflows without adapting the runtime task, stage prompts, schemas, agents, and tool policy.

## Available scaffolds

| Scaffold | Use when | Key features |
|---|---|---|
| `foreach-reduce/` | Extract a list of work items, verify each item, then synthesize a report. | parallel roots, `reduce.from`, `foreach.from`, final `reduce`, control schemas |
| `support-partition/` | Candidate findings need deterministic partitioning/dedup after verifier verdicts. | `foreach`, bundle-local `support.uses`, helper output, `inputPolicy.requiredReads` |
| `dag-required-reads/` | A nested analysis DAG must expose one child output and force downstream artifact reads. | `type: "dag"`, `outputFrom`, `inputPolicy.requiredReads` |
| `matrix-dag/` | Multiple review lenses should run in parallel and then join through reducers. | nested DAG, parallel roots, join reducers, `outputFrom`, final required read |
| `object-tool-fallback/` | A read-only workflow needs an optional custom/web extraction fallback. | object-form tool metadata, fallback tool, artifact-read gates |

## Copy pattern

```bash
mkdir -p .pi/workflows/my-workflow
cp -R skills/workflow-guide/scaffolds/foreach-reduce/* .pi/workflows/my-workflow/
```

Then edit:

1. `spec.json` name, description, agents, tools, stages, prompts, and data dependencies.
2. `schemas/*.json` fields consumed by `foreach.from`, reducers, support helpers, loop conditions, or required-read gates.
3. `helpers/*.mjs` only for support scaffolds, keeping helper refs bundle-local (`./helpers/name.mjs`).

Validate:

```text
/workflow validate .pi/workflows/my-workflow/spec.json
```

Resolve every error and warning before running or handing off.
