# workflow-guide scaffolds

Validated starter bundles for `workflow-guide` authoring. Copy and adapt the closest scaffold, or use a scaffold's documented provider-free initializer when the caller has already fixed the supported inputs. Then run `/workflow validate` before use.

These scaffolds are skill resources, not bundled starter workflows. Do not run them directly as product workflows without adapting or initializing the runtime contract and reviewing its prompts, schemas, agents, and tool policy.

## Available scaffolds

| Scaffold | Use when | Key features |
|---|---|---|
| `fixed-inventory/` | The caller has already authorized 1–8 documents and wants one editorial stakeholder-question extraction per document. | provider-free binding initializer, static inventory support, stable `foreach` IDs, exact-owner join, partial coverage ledger, escaped final render |
| `foreach-reduce/` | Extract a list of work items, verify each item, then synthesize a report. | parallel roots, `reduce.from`, `foreach.from`, final `reduce`, control schemas |
| `support-partition/` | Candidate findings need deterministic partitioning/dedup after verifier verdicts, then a byte-level check that every cited quote really exists at its file range. | `foreach`, bundle-local `support.uses`, helper output, `helpers/evidence-gate.mjs` (demotes unverifiable rows to needsHuman and marks integrity partial), `inputPolicy.requiredReads` |
| `dag-required-reads/` | A nested analysis DAG must expose one child output and force downstream artifact reads. | `type: "dag"`, `outputFrom`, `inputPolicy.requiredReads` |
| `matrix-dag/` | Multiple review lenses should run in parallel and then join through reducers. | nested DAG, parallel roots, join reducers, `outputFrom`, final required read |
| `object-tool-fallback/` | A read-only workflow needs an optional custom/web extraction fallback. | object-form tool metadata, fallback tool, artifact-read gates |
| `analysis-dossier/` | Expensive read-only corpus analysis that should be produced once and reused by a cheaper downstream workflow. | plan -> `foreach` shard analysis with file:line evidence, `partial` fan-in synthesis, `requiredReads` dossier render |

## Fixed-inventory initializer

Use `fixed-inventory` only when the complete document set is already known and caller-authorized. It does not discover inputs and is not an audit, factual verification, conformance, security, or release-readiness workflow. Its single model-backed stage interprets each assigned document and drafts stakeholder questions; static code owns inventory emission, fan-out identity, exact source reconciliation, coverage status, escaping, and rendering.

Create a JSON binding:

```json
{
  "name": "proposal-questions",
  "description": "Draft stakeholder questions for the approved proposal documents.",
  "items": [
    { "id": "proposal", "path": "docs/proposal.md" },
    { "id": "rollout", "path": "docs/rollout.md" }
  ]
}
```

Then initialize a fresh or empty bundle directory without any model/provider call:

```bash
node skills/workflow-guide/scaffolds/fixed-inventory/initialize.mjs binding.json .pi/workflows/proposal-questions
```

The initializer accepts only `name`, optional `description`, and 1–8 exact `{id,path}` rows; rejects unknown fields, duplicate/unsafe IDs, absolute or escaping paths, a symlink binding file or destination entry, and nonempty destinations; and uses exclusive file creation. Item `path` values are resolved later from the workflow run's working directory, not from the binding file or generated bundle. Within one installed scaffold revision, identical bindings produce byte-identical bundle files. It does not execute the generated workflow, inspect document contents, choose stakeholders, or establish that model output is correct. Review the binding and generated `spec.json`, confirm the `scout` agent and `read` tool ceiling fit, then run `/workflow validate .pi/workflows/proposal-questions/spec.json`. Use a model planning/discovery stage instead when the inventory is unknown or must be inferred. These checks are no-clobber hygiene, not an OS sandbox against a concurrently racing same-user process.

## Copy pattern

```bash
mkdir -p .pi/workflows/my-workflow
cp -R skills/workflow-guide/scaffolds/foreach-reduce/* .pi/workflows/my-workflow/
```

Then edit:

1. `spec.json` name, description, agents, tools, stages, prompts, data dependencies, and each model-backed stage's semantic `profileRole`. Reclassify roles when the adapted work changes purpose; do not copy them by stage-name analogy or confuse them with agent-context `role`.
2. `schemas/*.json` fields consumed by `foreach.from`, reducers, support helpers, loop conditions, or required-read gates.
3. `helpers/*.mjs` only for support scaffolds, keeping helper refs bundle-local (`./helpers/name.mjs`).

Validate:

```text
/workflow validate .pi/workflows/my-workflow/spec.json
```

Resolve every error and warning before running or handing off.
