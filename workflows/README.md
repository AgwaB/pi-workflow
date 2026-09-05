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

`deep-research` declares `low`, `medium`, and `high` execution profiles and explicitly defaults to `medium`. Interactive launches offer those profiles plus the base spec; headless omission uses the declared default. `low` is an explicit faster/cheaper quality trade-off, `low` and `medium` use profile-only max-2 batching for compatible `verify-claims` items, and `high` spends more reasoning while retaining singleton verification. Pass `--profile <name>` to bypass the prompt. Profile names are workflow-defined rather than reserved; see `docs/usage.md` for the optional profile schema and fallback guarantees.

Every official bundled workflow ends with the same user-facing completion envelope: a compact `completionSummaryMarkdown`, a workflow-specific `final-report.md` whose first detailed section is **Executive summary**, explicit evidence/limitations, and a final **Related artifacts** appendix. The deterministic renderer keeps each workflow's own authority model rather than forcing research verdicts onto review/readiness outputs. `deep-research` retains byte-identical `executive.md` plus claim-level `audit.md`; `deep-review` retains byte-identical `review.md`; `spec-review` and `impact-review` write `source-ledger.json`. Missing, partial, contradictory, or incompletely represented canonical inputs fail or block the final renderer instead of producing a clean completion.

Deep-research synthesis stays anchored to the runtime task and writes parent-facing text in that task's language unless another language is requested. Its report body preserves research scope/method, detailed findings, recommendations, action plan, evidence strength, gaps, sources, and audit totals. Deep-review uses finding dispositions and severity; each reviewer must account for every planned evidence path byte-for-byte as `read`, `ocr-extracted`, `metadata-only`, or `unreadable`. The deterministic reducer verifies `read` quotes against the planned file/range using a bounded descriptor read. OCR quotes require a current-user-owned, single-link, non-writable artifact under the non-symlinked `.pi/ocr-artifacts/` control-plane root plus an exact `<artifact>.binding.json` manifest that binds source path/digest and artifact path/digest. Missing, unverifiable, duplicate, or unusable required content forces `PARTIAL_REVIEW`, quarantines findings from that incomplete reviewer to `NEEDS_HUMAN`, makes the final render gate fail closed, and remains listed in the report. Singleton verifier evidence for every KEEP/WEAKEN/DROP disposition is likewise structured and checked against its exact repository file/range before partitioning. Spec-review uses conformance and requirement coverage; impact-review uses contract, regression-risk, and ship-readiness joins.

Spec-review's verifier `evidence`/`counterEvidence` arrays accept typed `{file,lineStart,lineEnd,quote,relevance?}` rows (up to 64 per array). KEEP/WEAKEN require real local evidence bytes, DROP requires real local counter-evidence bytes before removal, and positive requirement coverage also requires typed bytes. All typed citations must pass; legacy strings are display-only/unverified, even when they look like file:line, URL, or opaque web locators. No remote-byte attestation is implied. Ungrounded dispositions remain in `needsHuman`; the partition's `evidenceGate` records per-row results and file SHA-256 values. The renderer reconciles that ledger and rechecks current bytes, so missing gate data, changed bytes, missing/failed required source manifests or controls, and absent/inconsistent reports cannot yield `passed`.

Spec-review and the `support-partition` scaffold use equivalent bundle-local readers: current valid UTF-8 regular files under canonical cwd, at most 4 MiB, bounded descriptor reads, no symlinked descendants or escapes, and fail-closed observed mutation. Inclusive 1-based LF ranges retain CR, BOM, diff markers, and whitespace; a terminal LF creates an empty final line, and an out-of-bounds end is never clamped. Quotes must be exact substrings inside the range. This is current-byte verification, not semantic entailment, historical worker-read proof, or a same-user OS sandbox. See [Local review evidence](../docs/usage.md#local-review-evidence) for the complete reader and source-accounting boundaries.

Experimental or candidate workflows should live outside the bundled `workflows/` directory until their task fit is validated. Workflow-specific batched verification/devil-advocate path-ref variants are not shipped. The public runtime supports profile-only transparent max-2 batching for eligible `foreach` stages, while generic orchestration primitives such as `foreach`, `matrix`, `fanout`, and multi-query web-source calls remain available where documented.

Bundled workflows that verify source-backed claims can share the verification outcome ontology exported by the package: `verified`, `partially_supported`, `unsupported`, `conflicting`, and `verification_blocked`. Workflow helpers should keep dependency-free bundle-local shims in parity with that package export, because helper imports are bundled from the workflow spec directory. `verification_blocked` means verification could not complete because evidence, tool, source-access, or policy conditions blocked evaluation; it is never counted as verified. Deep-research uses this ontology. Workflows with different verdict models, such as finding disposition or ship readiness, should not be forced into it.

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

Bundle names resolve from the directory name (`/workflow run name ...`). Name priority is project-shared `<cwd>/workflows/`, then project-private `<cwd>/.pi/workflows/`, then user/global `~/.pi/agent/workflows/`, then this bundled package root. A higher-priority match shadows lower roots. Multiple matching forms at the winning priority fail closed as ambiguous.

`output.controlSchema` in a bundle is resolved relative to the workflow spec file, for example `./schemas/final-control.schema.json`.

## DAG authoring

Artifact-graph workflows use `from` for data edges, `after` for order-only edges, and `type: "dag"` containers for nested sibling-scoped graphs. A downstream stage consumes a container with `from: "analysis"`, which resolves to the container's `outputFrom` child. See `docs/usage.md` for the full DAG example, artifact bundle rules, and validation rules.

## Support helpers and web tools

Support nodes run bundle-local `.mjs` helper code inline instead of launching a subagent (deep-research uses them to compact normalize inputs and preserve audited verdict/sourceRef ledgers). Bundled workflows prefer the normalized web-source tools (`workflow_web_search`, `workflow_web_fetch_source`, `workflow_web_source_read`) over legacy web tools.

Legacy `fetch_content` workflow tasks use a run-scoped cache and a configurable inline text cap to reduce worker context pressure.

See `docs/usage.md` for the support helper API and path-containment rules ("Support helpers") and for web tool semantics, batching, cache layout, and the `fetch_content` security policy ("Run-scoped web-source cache" and "Web tools").
