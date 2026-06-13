# pi-workflow bundled starter workflows

These are deterministic named `/workflow` starter workflows. A workflow defines structure and role prompts; the concrete task is supplied at runtime. This directory is a small launch set and example library, not a complete workflow catalog.

Run them from the project root by exact filename alias, for example:

```text
/workflow list
/workflow show deep-research
/workflow validate deep-research
/workflow run deep-research "Research the current project architecture and verify the key claims. Use max depth."
```

Runtime selection is explicit: `/workflow run` takes an exact workflow name or explicit path plus a task string. Parent agents can use `/workflow recommend "<request>"` as a helper step to score workflow `catalog` metadata and choose a deterministic starting point. If a name is ambiguous across `.pi/workflows/`, `workflows/`, and `~/.pi/agent/workflows/`, `/workflow` fails closed.

## Bundled starter workflows

| Workflow | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize + foreach verifier + audit-claims support + final reduce | Research needs source-backed claims, dynamic breadth/depth, independent verification, deterministic evidence gating, or citations. Supports `quick`, `standard`, and `max` depth through task wording/input. |
| `deep-review` | `scout` | cheap triage + foreach review lenses + dedup support + foreach devil's advocate + verdict-partition support + reduce, read-only | Thorough multi-lens review where findings should be independently challenged before synthesis. |
| `spec-review` | `scout` | DAG-style parallel roots: extract spec + map implementation + inspect tests -> reduce candidates -> foreach verifier -> reduce report, read-only | Compare a spec or contract against implementation and tests, then report evidence-backed conformance gaps without editing files. |
| `implement-loop` | `delegate`, `scout` | loop: implement -> final check (validation+review) repeated until pass+ACCEPT or maxRounds/no-progress | Iterative implementation in a single managed worktree until validation passes and review accepts. Loop children are strictly serial (no child `from`, nested foreach/parallel/loop); no auto-merge; a human merges the reported worktree. |
| `test-repair-loop` | `delegate`, `scout` | loop: repair -> final test-check repeated until pass+ACCEPT or maxRounds/no-progress | Focused repair loop for failing tests or explicit validation commands. Uses one managed worktree, keeps patching separate from validation, and records a human-mergeable result. |

## Bundle layout

Workflows can be authored as either a flat file (`workflows/name.json`) or a directory-local bundle:

```text
workflows/name/
  spec.json
  templates.json
  helpers/
    support-helper.mjs
```

Bundle names resolve from the directory name (`/workflow run name ...`). If both `workflows/name.json` and `workflows/name/spec.json` exist, resolution fails closed as ambiguous.

`output.templateRef` in a bundle is resolved relative to `spec.json`, for example `./templates.json#/final`.

## DAG authoring

Stage-first workflows can use `from` for data edges, `after` for order-only edges, and `type: "dag"` containers for nested sibling-scoped graphs. A downstream stage consumes a container with `from: "analysis"`, which resolves to the container's `outputFrom` child. See `docs/usage.md` for the full DAG example and validation rules.

## Support helpers

A support node runs local helper code inline instead of launching a subagent:

```json
{
  "id": "audit-claims",
  "from": "verify-claims",
  "sourcePolicy": "partial",
  "support": {
    "uses": "./helpers/claim-evidence-gate.mjs",
    "options": { "downgradeExactQuantitativeWithoutSource": true }
  }
}
```

Helper API:

```js
export default async function helper({ sources, options, context }) {
  return { /* structured output */ };
}
```

Helper refs are intentionally directory-local only. Allowed refs start with `./` and point to `.mjs` files inside the workflow bundle directory. Parent-directory refs, absolute paths, home-relative paths, protocol refs (`file://`, `https://`), and `npm:` refs are rejected. This is containment and reproducibility, not a sandbox: helper code still runs inside the workflow process and is not constrained by subagent tool allowlists.

Additional workflow candidates are intentionally not bundled until their task fit is validated.
