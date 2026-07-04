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

Experimental or candidate workflows should live outside the bundled `workflows/` directory until their task fit is validated. `deep-research` also ships a path-ref-only batched verification variant at `workflows/deep-research/batched-verification.spec.json`; it is intentionally not registered as an official workflow name and must be invoked by explicit path after validation.

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

## Support helpers and web tools

Support nodes run bundle-local `.mjs` helper code inline instead of launching a subagent (deep-research uses them to compact normalize inputs and preserve audited verdict/sourceRef ledgers). Bundled workflows prefer the normalized web-source tools (`workflow_web_search`, `workflow_web_fetch_source`, `workflow_web_source_read`) over legacy web tools.

Legacy `fetch_content` workflow tasks use a run-scoped cache and a configurable inline text cap to reduce worker context pressure.

See `docs/usage.md` for the support helper API and path-containment rules ("Support helpers") and for web tool semantics, batching, cache layout, and the `fetch_content` security policy ("Run-scoped web-source cache" and "Web tools").
