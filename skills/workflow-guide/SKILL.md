---
name: workflow-guide
description: Create, modify, review, or validate pi-workflow workflow definitions. Use when the user asks to build/customize a /workflow workflow, validate a workflow spec, choose stage topology for a workflow being authored, adapt an existing workflow definition, or explain pi-workflow authoring rules.
---

# Workflow Guide

Use this skill before creating, editing, or reviewing a `pi-workflow` workflow.

## Required first step

Read the public usage guide and bundled workflow notes before giving workflow-authoring advice:

- `../../docs/usage.md`
- `../../workflows/README.md`

Resolve paths relative to this skill directory. Treat those docs as the source of truth for command surface, workflow resolution, artifact-graph semantics, safety policy, and validation.

Then read at least one shipped bundled spec as a quality reference before authoring, not only the scaffolds. The scaffolds show correct JSON shape; the bundled specs show correct *quality* — prompt discipline, evidence gates, partial-failure handling, and control/analysis split proven on real runs. Prefer the closest match:

- `../../workflows/deep-research/spec.json` — plan -> foreach research -> normalize/verify/audit -> synthesis; strong evidence and verification discipline, expensive/cheap stage separation.
- `../../workflows/deep-review/spec.json` — triage -> foreach reviewers -> support dedup -> foreach devil's-advocate -> support partition -> report; multi-pass challenge and deterministic verdict joins.
- `../../workflows/spec-review/spec.json` and `../../workflows/impact-review/spec.json` — mapping/synthesis shapes.

Copy their proven conventions (see "Quality design patterns"), not just their structure.

## Core rules

- Prefer a bundled workflow before inventing a new topology.
- When authoring a new workflow and a scaffold topology fits, start from `./scaffolds/<name>/` rather than inventing the JSON shape from scratch.
- Public `schemaVersion: 1` workflow specs use `artifactGraph.stages`.
- Stage order controls scheduling only; it does **not** pass prior output into a later plain `single` stage.
- If a model stage needs prior artifacts, use `single.from` or `reduce.from`; use `foreach.from` for array fan-out and support `from` for deterministic helpers. `after` is order-only.
- For static data-driven fan-out, use `foreach.from` with a simple dot path into upstream `control.json`.
- Use `each.itemIdentityPath` only for non-streaming foreach items with a stable string identity, and `each.itemPayloadPath` only for a distinct object payload. The runtime rejects missing, duplicate, unsafe, or colliding identities rather than falling back silently.
- Use `inputPolicy.terminalBarrier: "all-sources"` for an intentional all-terminal fan-in, `invalidateOnDependencyResume: true` only for static graph consumers that must discard stale generated evidence on source resume, and `maxCompiledPromptChars` when the final prompt needs a hard code-point ceiling. All three are opt-in; unsupported replay ownership fails closed.
- Use `type: "dynamic"` only for trusted adaptive orchestration that must create official child tasks at runtime with `ctx.agent()`, `ctx.helper()`, or `ctx.workflow()`. `maxNestedWorkflowDepth` is actual ancestor-relative nonconsumable headroom: depth 1 allows sibling children, not grandchildren; child settings cannot widen ancestor allowances. Missing/ambiguous ancestry grants no new depth. Keep the other work/runtime/tool budgets; depth is not a sibling-work cap. Hot `counters.nestedWorkflowDepth` is only a local 0/1 launch projection. Full retained historical depth requires explicit `readOrRebuildDynamicState(cwd, runId, { observeDescendants: true })` runtime inspection, is not persisted into the hot cache, and is never launch authority. Do not import private runtime modules into reusable helpers.
- For synthesis/fan-in, use `reduce.from` and require/encourage `workflow_artifact` reads for detailed upstream artifacts.
- For deterministic local post-processing, declare a `support` object with `support.uses` pointing to a bundle-local `./*.mjs` helper; support is trusted local code, not sandboxed subagent work and does not use a separate `type` value.
- For bounded iteration, use `loop` with fixed child stages, `maxRounds`, and deterministic `until`. Loop children are `single`/`reduce` only, run serially, and must not declare `from`/`after`: each child implicitly sources the earlier children of its round (for example `<loop>.r01.compare`), and the first child of every later round sources the previous round plus a `# Loop Carry-Forward Context` block. `until` must target the final child (`{ "stage": "<final-child>", "path": "$.field", "equals": true }`, or `all`/`any` combinators; predicates `equals`, `notEquals`, `lengthEquals`, `exists`), and that path must exist in the final child's control schema and few-shot example. Loops cannot be resumed; start a fresh run after changing the spec. See "Loop behavior" in `docs/usage.md` for the exact contract.
- Agent-declared tools are the authority ceiling; workflow `tools` can only narrow them.
- To reuse agent knowledge across stages, declare top-level `roles` (`fromAgent` extracts safe agent sections; `prompt` appends literal text). Compiled role text is injected as a `# Role Context` block; check the result with `/workflow roles <workflow>`. See "Roles" in `docs/usage.md`.
- Keep review/research workflows read-only unless the workflow explicitly documents managed-worktree mutation.
- Write-capable workflows need explicit worktree policy, validation/check stages, and protected-path awareness.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- Choose one of three user workflow scopes: project-private `.pi/workflows/<name>/spec.json`, project-shared/tracked `workflows/<name>/spec.json`, or user/global `~/.pi/agent/workflows/<name>/spec.json`. Flat `<name>.json` is fine only when no local schemas/helpers are needed.
- Name priority is project-shared `workflows/`, project-private `.pi/workflows/`, user/global, then the installed package bundle; higher roots shadow lower ones and ambiguity is fail-closed only within the winning priority.
- If the user asks to create a workflow but does not specify storage scope, ask them to choose project-private, project-shared/tracked, or user/global before writing. Treat changes to pi-workflow's official package `workflows/` as a separate promotion step requiring an explicit package-distribution request.
- For natural-language execution of existing workflows, prefer `workflow_list` and `workflow_run` when those tools are available; use `/workflow ...` commands as the deterministic manual fallback.
- Always run `/workflow validate <workflow-or-file>` before handing off or running a reusable workflow. There is no validate tool, so from an agent/tool context run it non-interactively from the project directory: `pi -p --no-session "/workflow validate <workflow-or-file>"`; it prints the same summary and `Warnings:` list as the interactive command and exits non-zero on an invalid spec.

## Authoring intake

When the workflow-definition request is vague, broad, or self-contradictory, do not write a spec yet. Clarify the authoring target first, then build collaboratively.

1. Identify the requested workflow-definition action: create new, modify existing, review existing, validate existing, or explain authoring rules.
2. Identify the workflow target path/name and storage scope. If not explicit, ask the user to choose project-private `.pi/workflows/`, project-shared/tracked `workflows/`, or user/global `~/.pi/agent/workflows/` before writing files. Modifying pi-workflow's official package bundle is a distinct, explicit package-distribution choice.
3. Ask only for decisions that determine the workflow graph and safety posture:
   - What runtime task will the workflow handle, and what final artifact should it produce?
   - What downstream decision depends on the output?
   - Where should the workflow live: project-private, project-shared/tracked, or user/global? Treat official package distribution as a later explicit promotion decision.
   - Is the workflow read-only, or write-capable with managed worktree expectations?
   - Is the graph a fixed DAG, static fan-out (`foreach`), synthesis (`reduce`), bounded `loop`, nested `dag`, support-helper pipeline, or trusted adaptive dynamic stage?
   - Which agents must exist, and what tool ceiling do they allow?
   - Which stage outputs are machine-read by later stages and therefore need control schemas?
4. For storage scope, prefer Pi's `question` tool when available instead of free-text. Use descriptions so the user can choose without knowing workflow internals:
   - `project-private`: save under the current project's `.pi/workflows/<name>/`; best for local paths or experiments. Discoverable only from this project and usually ignored by git.
   - `project-shared`: save under `workflows/<name>/`; best for a repo-committed workflow shared with the team.
   - `global`: save under `~/.pi/agent/workflows/<name>/`; best for personal workflows reused across projects. Avoid hard-coded project paths unless intentional.
   Example `question` tool shape: `question({questions:[{id:"workflow_storage_scope",label:"Storage",prompt:"Where should I save this workflow?",options:[{value:"project-private",label:"Project-private",description:"Use only in this project; save under .pi/workflows/<name>/."},{value:"project-shared",label:"Project-shared/tracked",description:"Commit with this repo under workflows/<name>/."},{value:"global",label:"Global/user",description:"Reuse from any project; save under ~/.pi/agent/workflows/<name>/."}],allowOther:true}]})`.
5. Survey existing workflows only when choosing a base template, adapting a known workflow, or checking whether a requested new workflow is unnecessary. Do not invent a new topology when an existing workflow definition already satisfies the authoring request.
6. If the request is contradictory (for example "read-only" plus "edit and commit"), name the conflict and offer concrete alternatives rather than silently resolving it. Workflow workers do not commit; mutation goes through a managed worktree for human review with no auto-merge.
7. Before writing a new or revised spec, briefly note the chosen stage graph (nodes, `from`/`foreach.from`/`reduce.from`/support edges, read/write policy, schemas/helpers, and storage path) when it materially affects cost, safety, or output shape. Do not ask the user to approve internal graph details unless the choice changes user-visible behavior, cost, storage scope, or mutation risk.

## Authoring workflow

When creating or changing a workflow:

1. Identify the workflow goal and whether an existing workflow definition can be reused or adapted.
2. Choose the workflow graph first: subagent stages plus support nodes where needed. Use `type: "dynamic"` only when static `foreach`/`dag`/`reduce` shapes cannot know the child work until runtime. If the graph choice materially affects cost, safety, output shape, or storage, state the chosen approach briefly before writing; otherwise proceed without asking about internal implementation details.
3. If one of the local scaffolds fits, copy it from `./scaffolds/` to the target workflow directory and adapt the copied files. Available scaffolds: `foreach-reduce`, `support-partition`, `dag-required-reads`, `matrix-dag`, `object-tool-fallback`, and `analysis-dossier`.
4. Define every data dependency explicitly.
5. Add `output.controlSchema` JSON Schema files for model outputs consumed by later stages; long prose belongs in `<analysis>`, not `<control>`.
6. Set tool ceilings and read/write policy.
7. Keep helper/controller code bundle-local and trusted: `support.uses`, `dynamic.uses`, and dynamic helper refs must start with `./`, use supported bundle-local extensions, and stay inside the workflow bundle.
8. Apply the "Quality design patterns" below; do not stop at a spec that merely validates.
9. Add few-shot control examples for every model-authored control schema
   that has required nested object fields, especially foreach workers and
   reducers. Show exact keys and compact valid shapes, not prose-only
   descriptions. For required nested arrays/objects, the prompt must show
   the container type literally, for example:
   `"points": []`, `"evidence": []`, `"coverageGaps": {}`.
10. Validate with `/workflow validate <workflow-or-file>` (from an agent/tool context: `pi -p --no-session "/workflow validate <workflow-or-file>"` in the project directory).
11. Do not ignore validation warnings. Treat a `foreach` path warning
    (the path's top-level key is not a property of the source stage's
    control schema) as a likely typo that would fan out over nothing at
    runtime, and fix the path or the source schema. Treat a
    readOnly-with-mutation-tools warning (a stage declares
    `readOnly: true` but keeps a mutation-capable tool such as `bash`) as
    intentional only when the stage relies on worktree isolation; otherwise
    remove the tool. Treat workflow-quality warnings about prompt/schema
    drift, fragile required item keys, missing nested shape skeletons, or
    huge reducers as blockers for reusable workflows: fix with schema/prompt
    alignment, few-shot skeletons, support helpers, or reducer splits before
    running.
12. Report the exact validation result, every warning, and any remaining safety notes.

## Runtime acceptance dry run

`/workflow validate` checks form, not behavior. Before treating a new or materially changed workflow as trustworthy, run a bounded representative task and prove the workflow's runtime invariants. Do not turn one observed workflow's values into universal constants; declare the expected counts, identities, and completion rules for the workflow being authored.

1. **Declare acceptance invariants before launch.** Record the expected fan-out count and stable item ids, permitted resolved agents/models/tools, required evidence shape, planned fan-in counts, tolerated failure policy, and final status/verdict rule. Static validation does not prove provider credentials, quota, model availability, or model output conformance; classify those separately from graph/helper defects.
2. **Inspect materialization, not only the plan.** Use `/workflow` or `pi-workflow inspect <run-id> --results`, then inspect `run.json`, the plan `control.json`, and relevant `source-manifest.json` files. Reconcile planned items against materialized task `specId`/`displayName` values and against the stable identity echoed in each worker control. Treat manifest `source` names and in-memory source-map keys as routing aliases, not business identity; an alias may be a bare stage name and need not equal the foreach item id. Never derive assignment identity from alias shape, object enumeration order, title text, or array position. Prefer `each.itemIdentityPath` plus an explicit id in the item and worker output.
3. **Reconcile every fan-in boundary.** Mechanically compare the applicable planned ids -> materialized task ids -> valid worker controls -> decision/verifier ids -> final/output ids, omitting only stages the graph does not contain. Missing, duplicate, extra, malformed, or completed-but-mismatched rows are integrity failures, not empty success. Preserve those failures in source-status accounting and choose a conservative partial/blocked result.
4. **Inspect evidence and provenance.** For KEEP/WEAKEN and positive coverage, require structured repository or source evidence rather than free-form strings; DROP needs verified counter-evidence before removal too. For local evidence, mechanically verify every cited path/range and quote against the source bytes (including diff markers and whitespace when applicable), and account for every planned required source; unreadable, metadata-only, missing, or unverifiable sources must force the workflow's conservative partial/blocked path. Confirm every final row retains its producer/origin and verifier lineage through every transform actually present, for example dedup, partition, merge, packet, and render stages.
5. **Exercise degradation and finality.** On a cheap fixture, make one worker absent/invalid or synthesize an empty slice when practical. Confirm `terminalBarrier`, `sourcePolicy`, missing-row handling, and final status agree. A missing or inconsistent narrative/report stage must not emit a machine verdict that claims complete success merely because the canonical ledger is otherwise clean.
6. **Audit deterministic helpers and side effects.** For the helper behaviors actually present, run fixtures for source reordering, duplicate-like-but-distinct rows, true duplicates, nested merges, missing decisions, and untrusted render text. A read-only workflow's support helpers must also avoid undeclared filesystem, process, or network side effects; `readOnly` tool narrowing does not sandbox support code.
7. Tune prompts, schemas, and helpers from the evidence, re-run focused regression tests, then re-run `/workflow validate`. Repeat the full provider-backed run only when the fix affects model prompts, stage topology, runtime materialization, or another invariant that focused deterministic tests cannot cover. A run executes its copied bundle snapshot, so after changing a spec, schema, or helper, start a fresh acceptance run rather than resuming a historical run and expecting new bundle bytes. State clearly whether the final state is validation-only, helper-tested after a prior dry run, or dry-run on the exact final revision.

## Scaffold usage

Scaffolds under `./scaffolds/` are validate-ready starter bundles for common topologies. Use them to reduce JSON-shape mistakes, then adapt the copy to the user's workflow.

- `foreach-reduce/`: parallel mapping or planning, reduce to work items, foreach verification, final report.
- `support-partition/`: collect candidates, foreach verifier, deterministic support partition/dedup, byte-level evidence gate, final report.
- `dag-required-reads/`: nested DAG with `outputFrom` and downstream `inputPolicy.requiredReads`.
- `matrix-dag/`: parallel lens DAG with join reducers and final required artifact read.
- `object-tool-fallback/`: read-only extraction with object-form optional tool metadata and fallback tool.
- `analysis-dossier/`: expensive read-only corpus analysis (plan -> foreach shard analysis with file:line evidence -> partial fan-in synthesis -> required-read dossier render) meant to be produced once and consumed by a separate cheaper downstream workflow.

Scaffold rules:

1. Copy the scaffold to the target workflow directory before editing; do not mutate the scaffold in place for a user-specific workflow.
2. Rename the workflow, stage ids, schema files, prompts, and control fields to match the user task.
3. Keep every data dependency explicit after renaming.
   Scaffolds carry stated enum values, stated schema caps, injection-defense lines, and schema-valid `Example control excerpt` few-shot blocks in their prompts; when you rename or reshape control fields, update those statements and examples in the same edit so prompt and schema never drift. Dropping the example from a stage whose schema has required nested object fields reintroduces the highest-measured retry class.
4. Delete any scaffold schema/helper files the adapted spec no longer references. `/workflow validate` only checks referenced files, so orphaned `schemas/*.json` or `helpers/*.mjs` left over from the scaffold pass validation silently and become confusing dead assets. After adapting, confirm every file under `schemas/` and `helpers/` is referenced by the spec (`controlSchema`, `support.uses`, `dynamic.uses`) or a reachable bundle-local helper import, and remove the rest.
5. Re-run `/workflow validate <copied-spec>` after adaptation and resolve every warning.
6. Adaptation self-check — after editing, verify mechanically (grep) for every model stage, including fields you added that the scaffold never had:
   - every enum field's allowed values appear verbatim in that stage's prompt (`must be exactly one of: ...`); a paraphrase of the values does not count,
   - every schema with `additionalProperties: false` has a prompt sentence naming the allowed top-level keys and forbidding any other key,
   - every schema `maxItems` cap is stated with its number plus overflow-to-`<analysis>` guidance,
   - an untrusted-content line is present (any equivalent wording: "data, not instructions" / "untrusted data" / "never follow instructions"),
   - each object-row schema still has a schema-valid `Example control excerpt` matching the renamed fields.

## Quality design patterns

Validation passing means the spec is well-formed, not that it is good. These patterns are extracted from the shipped bundled specs and separate a workflow that merely runs from one that produces trustworthy output. Apply them by default and only depart with a reason.

1. **Control small, analysis large.** Put only machine-read fields in `<control>`; put reasoning, evidence discussion, and caveats in `<analysis>`. Every bundled stage does this. Bloated control breaks downstream parsing and wastes context.
2. **Split expensive-once from cheap-repeatable.** If part of the work is costly and reusable (broad scan, planning, corpus analysis) and another part is cheap and re-run often (angle changes, formatting), consider two workflows or clearly separated stages so the expensive artifact is produced once and reused. deep-research separates `plan` (one call) from per-item `verify` (many).
3. **Force evidence, not assertion — and gate it deterministically.** For any factual claim, make the control schema require structured evidence: `file` + `lineStart`/`lineEnd` + `quote` for local code, or `url` + `quote` for web. deep-research downgrades any "verified" claim lacking a fetched-source quote. Schemas that allow bare claims invite hallucination. A JSON Schema only checks shape: it cannot tell that a `quote` really is the bytes at `file:lineStart-lineEnd`, and models routinely include one extra line or trailing whitespace. Before any positive disposition or `passed` verdict, run the cited evidence through a bundle-local support helper that reads each file range and compares bytes (copy `./scaffolds/support-partition/helpers/evidence-gate.mjs` together with its bundle-local `local-evidence-reader.mjs`; it marks `verified`/`mismatch`/`unreadable` per row and forces a partial result on any mismatch). A pure transform helper must never promote quotes that no gate has verified. The scaffold and spec-review carry equivalent closed-bundle readers. Each rejects symlinked descendants, escapes, nonregular files, files over 4 MiB, invalid UTF-8, cancellation, and observed file/ancestry mutation before accepting descriptor reads bounded to 64 KiB chunks with at most 4 MiB + 1 byte allocated; this is not an OS sandbox against continuously racing same-user processes. Inclusive 1-based ranges split on LF and retain CR, BOM, diff markers and whitespace; a terminal LF creates an empty final line, and an out-of-bounds end is never clamped. Spec-review requires both range endpoints; the scaffold alone permits omitted ranges as explicitly file-wide evidence, not symbol attestation. Quotes are exact substrings within the declared range, not normalized text or proof of semantic entailment. In spec-review, typed `evidence`/`counterEvidence` rows are `{file,lineStart,lineEnd,quote,relevance?}` (at most 64 rows per verifier array). Legacy strings remain display-only: even plausible file:line syntax cannot establish support. KEEP/WEAKEN need typed evidence; DROP needs typed counter-evidence before removal, and any failed typed citation or missing required source prevents complete evidence. Partition persists per-row results and the renderer reconciles them and rechecks current bytes before `passed`; old partitions without these results remain unverified. Positive requirement-coverage claims likewise need typed bytes; preliminary no-issue notes are not proof. Spec-review reconciles exactly one explicit requirementId/status row against every unique exact ID in the bounded runtime-attested extract-spec control (no title/order/alias inference). Status is covered, gap, partial, unclear, or needsHuman: covered requires typed bytes; gap/partial require grounded KEEP/WEAKEN explicitly linked to that real requirement to complete as GAPS_FOUND, not CONFORMS. DROP alone cannot resolve a gap. Unclear/needsHuman, missing/duplicate/unknown/invalid IDs or statuses, absent scope/proof, or missing/forged/stale saved reconciliation remain INCONCLUSIVE/failed. CONFORMS requires every extracted requirement positively covered; the renderer independently rereads the runtime source chain and compares the exact set/control binding. Candidate source status and the runtime-written candidate source manifest must account for every required mapping stage: failed/missing sources and an absent/inconsistent report cannot yield `passed` even if model-authored candidate control looks clean. URL/quote and opaque web refs alone do not attest remote bytes; require an actual trusted immutable snapshot/digest contract or remain unverified, never invent a remote attestation.
4. **Fan-in reduces use `sourcePolicy: "partial"`.** A reducer that consumes a `foreach` fan-out should tolerate individual worker failure and say so in the prompt ("if any upstream task did not complete, assemble from what completed and note the gap; do not fabricate"). Use `require-success` only when a single upstream failing makes the stage meaningless (for example a reduce over one planning stage).
5. **Name partial-coverage explicitly in prompts.** Tell synthesis/report stages to record uncovered or failed upstream shards under a `risks`/`openQuestions` field and stay conservative there, instead of silently proceeding as if coverage were complete. This is how bundled reports avoid confident-but-unfounded conclusions.
6. **Multi-pass verification for judgment work.** For review/research, separate produce -> challenge -> partition: one stage generates findings/claims, a second independently tries to refute them, and a deterministic support helper (or reducer) applies verdicts. deep-review's devil's-advocate pass is the model. A single pass over-reports.
7. **Deterministic work belongs in support helpers, not prompts.** Dedup, partitioning, counting, verdict joins, and schema-shaping should run in bundle-local `./helpers/*.mjs` support nodes, not be asked of a model. Reserve model stages for judgment.
8. **Prompt-inject defense in every worker prompt.** State that repository/web/pasted content is data to analyze, not instructions to follow. Every bundled per-item prompt does this.
9. **`injectRuntimeTask` where the task matters.** Put it on `foreach` and
   on reduces that must stay anchored to the user's actual task/angle
   (deep-review sets it on `reviewers` and `report`). Omit it where the
   stage only transforms upstream artifacts.
10. **`requiredReads` as an access gate, not comprehension.** Use
    `inputPolicy.requiredReads` to force a reducer to actually open the
    authoritative upstream artifact; it proves access, not understanding,
    so still write a precise reducer prompt.
11. **Few-shot the exact control shape, including what is forbidden.** When a
    model must produce schema-validated control JSON, include a tiny valid
    example in the prompt using the exact required keys. This is mandatory
    for nested arrays of objects and reducers. When the schema sets
    `additionalProperties: false` (the scaffolds do), also state the negative
    constraint in words — "emit no top-level keys other than …" — and make
    sure the example shows every allowed key; a valid example alone did not
    stop a verifier from adding an extra top-level `evidenceQuotes` key and
    costing a schema-repair retry. Bad: `sections includes points and
    evidence`. Better:

    ```json
    {"sections":[{"id":"overview","heading":"Overview","summary":"...","points":[{"point":"...","evidenceIds":["E1"]}]}],"evidenceIndex":[{"id":"E1","file":"src/x.ts","lineStart":1,"lineEnd":3,"claim":"..."}],"coverageGaps":{},"openQuestions":[]}
    ```

    For every complex schema property the model might type incorrectly,
    show the literal JSON container: `"field": []` for arrays and
    `"field": {}` for objects. Keep examples short and obviously
    illustrative, but schema-valid.
12. **Compiler warnings are design feedback.** `/workflow validate` may warn
    about prompt/schema drift (`array with reason` vs `string[]`), fragile
    required item keys without a JSON skeleton (`mechanism`, `decision`),
    missing nested array/object shapes (`"points": []`,
    `"coverageGaps": {}`), and huge foreach fan-in reducers likely to hit
    length/control-bloat limits. Fix these before first real runs; do not
    treat them as cosmetic.
13. **Identity and cardinality are control-plane contracts.** Give every
    planned foreach/verification row a stable explicit id, echo it in worker
    control, and reconcile the complete id sets at each fan-in. Runtime source
    aliases, task order, and human titles are presentation/routing data, not
    identity. Count equality alone is insufficient because one missing row and
    one duplicate row can cancel numerically.
14. **Deterministic transforms must be lossless and schema-checked.** Dedup
    only with concrete same-entity evidence such as overlapping locations or
    exact source evidence, not fuzzy title similarity alone. For a confirmed
    merge, union evidence, locations, severity, origins, verifier records, and
    nested lineage deterministically. Sort by canonical identity before
    assigning generated ids, and validate every support output against the
    exact downstream contract.
15. **The canonical ledger outranks narrative synthesis.** Derive counts,
    disposition coverage, and the machine verdict from deterministic ledger
    state. Treat an absent/inconsistent report or uncovered source as partial
    or blocked, even if all remaining findings are clean. Narrative stages may
    summarize the ledger but must not erase rejected/excluded audit rows,
    missing rows, provenance, or integrity failures.
16. **Read-only and untrusted-output rules include support code.** A
    read-only workflow's trusted helpers should be pure artifact transforms;
    any filesystem/process/network side effect needs an explicit workflow
    contract and safety review. Deterministic renderers must escape untrusted
    Markdown/HTML text, choose code fences that cannot be closed by embedded
    content, and mechanically prove that every authoritative disposition is
    represented or auditable.

## Control schema and output gotchas

- Workflow specs are JSON-only; `.yaml` and `.yml` specs are not supported.
- Keep `<control>` small and machine-readable. Put detailed reasoning, evidence, and caveats in `<analysis>`.
- Put compact few-shot `<control>` examples in prompts when the schema has
  required nested object keys; examples should be schema-valid and use exact
  field names plus exact container shapes (`"arrayField": []`,
  `"objectField": {}`).
- Add `output.controlSchema` for any model output consumed by `foreach.from`,
  support helpers, reducers, loop conditions, or downstream deterministic
  checks.
- If the control schema constrains `control.schema` with `const` or `enum`,
  treat that value as the semantic output protocol id and state it verbatim in
  the prompt/example. Never derive it from the control-schema filename.
- The supported JSON Schema subset is intentionally limited. Avoid `$ref`,
  `$defs`, `definitions`, and `pattern`; use simple `type`, `required`,
  `properties`, `items`, `enum`, `const`, bounds, `additionalProperties`,
  and simple combinators supported by the validator.
- Make downstream paths match schema properties exactly. A typo in `$.items`
  or another `foreach.from` path can fan out over nothing.
- `inputPolicy.requiredReads` proves workflow-artifact reads, not semantic
  understanding. Use it as an access/evidence gate, not as a substitute for a
  good prompt or reducer.

## Workflow review finding template

When reviewing an existing workflow spec, report each issue with:

```text
Severity: blocker | high | medium | low
File/path:
Problem:
Why it matters:
Concrete fix:
Validation:
```

Prioritize issues that can break scheduling, drop upstream data, bypass evidence gates, mutate unexpectedly, fail validation, or make outputs impossible to consume deterministically.

## Validation readiness checklist

Before handing off or recommending a reusable workflow run, verify or report as a blocker:

- `/workflow validate <workflow-or-file>` result and all warnings.
- Required agents exist and their declared tool ceilings allow the workflow tools.
- `readOnly` and tool lists match the intended side-effect policy.
- Every `single.from`, `foreach.from`, `reduce.from`, support `from`, and `dag.outputFrom` reference resolves.
- Every downstream-consumed control field has a schema and a bounded prompt contract.
- Every KEEP/WEAKEN or positive coverage claim citing local `file`/line/`quote` evidence passes through a deterministic byte-level evidence gate (support helper) before the final report; DROP requires verified counter-evidence before removal. A schema check alone is not a gate, and legacy locator strings or remote-only refs cannot substitute for byte attestation.
- Loop stages: children declare no `from`/`after`, the `until` path exists in the final child's control schema and few-shot example, and the acceptance plan states that an interrupted loop is re-run, not resumed.
- Support helper paths are bundle-local, `.mjs`, and trusted.
- No orphaned `schemas/*.json` or `helpers/*.mjs` files remain that the spec does not reference (common after adapting a scaffold).
- Write-capable workflows document worktree policy, protected-path expectations, and validation/check stages.
- Runtime task examples include scope, exclusions, final artifact, and success metric.
- Runtime acceptance invariants declare expected item identities/counts, permitted resolved agents/models/tools, evidence requirements, degradation behavior, and final status/verdict rules.
- Every fan-in reconciles its applicable planned, materialized, valid, decision/verification, and final/output id sets; aliases and enumeration order are never treated as business identity.
- Deterministic helper fixtures cover reordering, missing/duplicate/extra rows, lossless merge/dedup, partial failure, report absence/inconsistency, and untrusted rendering where those behaviors exist.
- Support-helper side effects match the workflow's read/write declaration, and final renderers preserve every authoritative disposition and provenance row.
- The "Quality design patterns" were applied or their omission is justified (especially control/analysis split, evidence-forcing schemas, few-shot exact control examples, `partial` fan-in, and prompt-inject defense).
- State whether the final revision is validation-only, helper-tested after a prior dry run, or dry-run exactly as delivered.

## Promotion checklist

For a workflow promoted from a private experiment to a shared or official package workflow:

- Promote a private `.pi/workflows/<name>.json` or `.pi/workflows/<name>/spec.json` experiment to the owning project's `workflows/<name>/spec.json` with schemas/helpers in that bundle directory.
- When the target is pi-workflow's official installed bundle, require an explicit package-distribution request, prefer a new project-scoped fork name while experimenting, and only then update the official package bundle.
- Update `workflows/README.md` and `docs/usage.md`; update `README.md` if the workflow is user-facing.
- Add or update tests when the bundled workflow list, package contents, schema behavior, helper behavior, or docs examples are expected to remain stable.
- Run at least `/workflow validate <name-or-path>` and the relevant project checks (`npm test`, `npm run typecheck`, `npm run e2e`, or `npm run pack:dry`) when package surface changes require them.

## Response expectations

When authoring or reviewing a workflow, report:

- which existing workflow was used or why none fit,
- the stage graph,
- every `single.from`, `foreach.from`, `reduce.from`, and support `from` data dependency,
- write-capable stages and worktree policy,
- required agents and tool ceilings,
- `output.controlSchema` files and workflow control fields used by downstream stages,
- exact validation command and result,
- every validation warning and how it was resolved or why it is acceptable,
- which quality design patterns were applied and any deliberately omitted,
- whether the workflow was dry-run or is validation-only,
- any blockers before running the workflow.
