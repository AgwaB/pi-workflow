# pi-workflow bundled workflows

These are deterministic named `/workflow` workflow files. A workflow defines structure and role prompts; the concrete task is supplied at runtime.

Run them from the project root by exact filename alias, for example:

```text
/workflow list
/workflow show deep-research
/workflow validate deep-research
/workflow run deep-research "Research the current project architecture and verify the key claims. Use max depth."
```

Runtime selection is explicit: `/workflow run` takes an exact workflow name or explicit path plus a task string. Parent agents can use `/workflow recommend "<request>"` as a helper step to score workflow `catalog` metadata and choose a deterministic starting point. If a name is ambiguous across `.pi/workflows/`, `workflows/`, and `~/.pi/agent/workflows/`, `/workflow` fails closed.

## Bundled workflows

| Workflow | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize + foreach verifier + audit-claims transform + final reduce | Research needs source-backed claims, dynamic breadth/depth, independent verification, deterministic evidence gating, or citations. Supports `quick`, `standard`, and `max` depth through task wording/input. |
| `deep-review` | `scout` | cheap triage + foreach review lenses + foreach devil's advocate + reduce, read-only | Thorough/panel review where findings should be independently challenged before synthesis. |
| `implement-loop` | `delegate`, `scout` | loop: implement -> final check (validation+review) repeated until pass+ACCEPT or maxRounds/no-progress | Iterative implementation in a single managed worktree until validation passes and review accepts. Loop children are strictly serial (no child `from`, nested foreach/parallel/loop); no auto-merge; a human merges the reported worktree. |
| `test-repair-loop` | `delegate`, `scout` | loop: repair -> final test-check repeated until pass+ACCEPT or maxRounds/no-progress | Focused repair loop for failing tests or explicit validation commands. Uses one managed worktree, keeps patching separate from validation, and records a human-mergeable result. |

## Bundle layout

Workflows can be authored as either a flat file (`workflows/name.json`) or a directory-local bundle:

```text
workflows/name/
  spec.json
  templates.json
  helpers/
    transform-helper.mjs
```

Bundle names resolve from the directory name (`/workflow run name ...`). If both `workflows/name.json` and `workflows/name/spec.json` exist, resolution fails closed as ambiguous.

`output.templateRef` in a bundle is resolved relative to `spec.json`, for example `./templates.json#/final`.

## Transform stages and helpers

A transform stage runs local helper code inline instead of launching a subagent:

```json
{
  "id": "audit-claims",
  "type": "transform",
  "from": "verify-claims",
  "helper": "./helpers/claim-evidence-gate.mjs",
  "options": { "downgradeExactQuantitativeWithoutSource": true }
}
```

Helper API:

```js
export default async function helper({ sources, options, context }) {
  return { /* structured output */ };
}
```

Helper refs are intentionally directory-local only. Allowed refs start with `./` and point to `.mjs` files inside the workflow bundle directory. Parent-directory refs, absolute paths, home-relative paths, protocol refs (`file://`, `https://`), and `npm:` refs are rejected. This is containment and reproducibility, not a sandbox: helper code still runs inside the workflow process.

Deferred workflow candidates live under `internal/plans/deferred-workflows/` and are not bundled workflow surface.
