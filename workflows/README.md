# pi-workflow bundled workflows

These are the official bundled `/workflow` starters shipped with pi-workflow. A workflow defines structure and role prompts; the concrete task is supplied at runtime.

Run them from the project root by exact workflow name, for example:

```text
/workflow list
/workflow show deep-research
/workflow validate deep-research
/workflow run deep-research "Research the current project architecture and verify the key claims. Use max depth."
```

For spec-less direct dynamic execution, use `/workflow dynamic "<task>"`; it does not select one of the bundled workflow specs below.

## Official bundled workflows

| Workflow | Required agents | Use when |
|---|---|---|
| `deep-research` | `researcher` | Use when you need a grounded answer or summary based on source material. |
| `deep-review` | `scout` | Use when you want code or design reviewed carefully from multiple angles. |
| `spec-review` | `scout` | Use when you want to check whether requirements, an API spec, or a contract are reflected in the implementation and tests. |
| `impact-review` | `scout` | Use before merging or releasing a change to check affected areas, risks, missing tests, and missing docs. |

More official workflows are planned. Experimental or candidate workflows should live outside the bundled `workflows/` directory until their task fit is validated.

## Bundle layout

Bundled workflows use directory-local bundles:

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

Workflow runs now prefer normalized web-source tools: `workflow_web_search`, `workflow_web_fetch_source`, and `workflow_web_source_read`. Normalized web sources are stored inside `.pi/workflows/<run-id>/web-source-cache/`, model-visible tool results expose only compact cards/source refs/snippets, and agents should use `workflow_web_source_read` instead of reading cache files directly. Batch several source fetches with `urls: [...]` or `sources: [...]`, and batch several snippets from one sourceRef with `queries: [...]` or `reads: [...]` to reduce repeated tool turns; use `claim` plus distinctive `terms` for candidate quote windows with match metadata when the exact quote is unknown. Deep-research also uses support helpers to compact normalize inputs and preserve audited verdict/sourceRef ledgers before final synthesis. Custom extension `fetch_content` providers are disabled by default for normalized source fetches unless the workflow security policy explicitly trusts private-host behavior; this avoids accepting opaque provider network fetches as SSRF-safe. Legacy `fetch_content` tasks still use `.pi/workflows/<run-id>/source-cache/fetch-content/`; set `PI_WORKFLOW_FETCH_CONTENT_CACHE=0` to opt out for a run. Treat cache-enabled benchmark runs as a separate cohort from older uncached measurements.
