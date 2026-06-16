# pi-workflow bundled starter workflows

These are deterministic named `/workflow` starter workflows. A workflow defines structure and role prompts; the concrete task is supplied at runtime. This directory is a small launch set and example library, not a complete workflow catalog.

Run them from the project root by exact filename alias, for example:

```text
/workflow list
/workflow show deep-research
/workflow validate deep-research
/workflow run deep-research "Research the current project architecture and verify the key claims. Use max depth."
```

Runtime selection is explicit: `/workflow run` takes an exact workflow name or explicit path plus a task string. Use `/workflow list` to discover available workflows and choose a deterministic starting point. If a name is ambiguous across `.pi/workflows/`, `workflows/`, and `~/.pi/agent/workflows/`, `/workflow` fails closed.

## Bundled starter workflows

| Workflow | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize + foreach verifier + audit-claims support + final reduce | Research needs source-backed claims, dynamic breadth/depth, independent verification, deterministic evidence gating, or citations. Supports `quick`, `standard`, and `max` depth through task wording/input. |
| `deep-review` | `scout` | cheap triage + foreach review lenses + dedup support + foreach devil's advocate + verdict-partition support + reduce, read-only | Thorough multi-lens review where findings should be independently challenged before synthesis. |
| `spec-review` | `scout` | parallel roots: extract spec + map implementation + inspect tests -> reduce candidates -> foreach verifier -> reduce report, read-only | Compare a spec or contract against implementation and tests, then report evidence-backed conformance gaps without editing files. |
| `impact-review` | `scout` | multi-join DAG: scope/implementation/validation maps -> contract/state/validation/docs/security lenses -> consistency/regression/ship-readiness joins -> final synthesis, read-only | Review ship impact for changed or proposed work, especially missing tests, docs, release work, compatibility risk, and follow-up actions. |

## Bundle layout

Bundled starter workflows use directory-local bundles:

```text
workflows/name/
  spec.json
  schemas/
    stage-control.schema.json
  helpers/
    support-helper.mjs
```

Bundle names resolve from the directory name (`/workflow run name ...`). If two specs expose the same workflow name, resolution fails closed as ambiguous.

`output.controlSchema` in a bundle is resolved relative to the workflow spec file, for example `./schemas/final-control.schema.json`.

## DAG authoring

Artifact-graph workflows use `from` for data edges, `after` for order-only edges, and `type: "dag"` containers for nested sibling-scoped graphs. A downstream stage consumes a container with `from: "analysis"`, which resolves to the container's `outputFrom` child. See `docs/usage.md` for the full DAG example, artifact bundle rules, and validation rules.

## Support helpers

A support node runs local helper code inline instead of launching a subagent. Declare it with a `support` object, not a separate `type` value:

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
  return { schema: "helper-output-v1", digest: "...", value: { /* control data */ } };
}
```

Helper refs are intentionally directory-local only. Allowed refs start with `./` and point to `.mjs` files inside the workflow bundle directory. Parent-directory refs, absolute paths, home-relative paths, protocol refs (`file://`, `https://`), and `npm:` refs are rejected. This is containment and reproducibility, not a sandbox: helper code still runs inside the workflow process and is not constrained by subagent tool allowlists.

Experimental workflow candidates should live outside the bundled `workflows/` directory until their task fit is validated.
