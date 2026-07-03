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

## Core rules

- Prefer a bundled workflow before inventing a new topology.
- When authoring a new workflow and a scaffold topology fits, start from `./scaffolds/<name>/` rather than inventing the JSON shape from scratch.
- Public `schemaVersion: 1` workflow specs use `artifactGraph.stages`.
- Stage order controls scheduling only; it does **not** pass prior output into a later plain `single` stage.
- If a stage needs prior artifacts, use `reduce.from`, `foreach.from`, or support `from`.
- For static data-driven fan-out, use `foreach.from` with a simple dot path into upstream `control.json`.
- Use `type: "dynamic"` only for trusted adaptive orchestration that must create official child tasks at runtime with `ctx.agent()`, `ctx.helper()`, or `ctx.workflow()`.
- For synthesis/fan-in, use `reduce.from` and require/encourage `workflow_artifact` reads for detailed upstream artifacts.
- For deterministic local post-processing, declare a `support` object with `support.uses` pointing to a bundle-local `./*.mjs` helper; support is trusted local code, not sandboxed subagent work and does not use a separate `type` value.
- For bounded iteration, use `loop` with fixed child stages, `maxRounds`, and deterministic `until`.
- Agent-declared tools are the authority ceiling; workflow `tools` can only narrow them.
- To reuse agent knowledge across stages, declare top-level `roles` (`fromAgent` extracts safe agent sections; `prompt` appends literal text). Compiled role text is injected as a `# Role Context` block; check the result with `/workflow roles <workflow>`. See "Roles" in `docs/usage.md`.
- Keep review/research workflows read-only unless the workflow explicitly documents managed-worktree mutation.
- Write-capable workflows need explicit worktree policy, validation/check stages, and protected-path awareness.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- Project workflows should be saved under `.pi/workflows/<name>.json` or a bundle directory with `spec.json`, schemas, and helpers.
- For natural-language execution of existing workflows, prefer `workflow_list` and `workflow_run` when those tools are available; use `/workflow ...` commands as the deterministic manual fallback.
- Always run `/workflow validate <workflow-or-file>` before handing off or running a reusable workflow.

## Authoring intake

When the workflow-definition request is vague, broad, or self-contradictory, do not write a spec yet. Clarify the authoring target first, then build collaboratively.

1. Identify the requested workflow-definition action: create new, modify existing, review existing, validate existing, or explain authoring rules.
2. Identify the workflow target path/name when known. Project workflows should start under `.pi/workflows/`; bundled/reusable workflows should use `workflows/<name>/spec.json` only when explicitly intended for the package.
3. Ask only for decisions that determine the workflow graph and safety posture:
   - What runtime task will the workflow handle, and what final artifact should it produce?
   - What downstream decision depends on the output?
   - Is the workflow read-only, or write-capable with managed worktree expectations?
   - Is the graph a fixed DAG, static fan-out (`foreach`), synthesis (`reduce`), bounded `loop`, nested `dag`, support-helper pipeline, or trusted adaptive dynamic stage?
   - Which agents must exist, and what tool ceiling do they allow?
   - Which stage outputs are machine-read by later stages and therefore need control schemas?
4. Survey existing workflows only when choosing a base template, adapting a known workflow, or checking whether a requested new workflow is unnecessary. Do not invent a new topology when an existing workflow definition already satisfies the authoring request.
5. If the request is contradictory (for example "read-only" plus "edit and commit"), name the conflict and offer concrete alternatives rather than silently resolving it. Workflow workers do not commit; mutation goes through a managed worktree for human review with no auto-merge.
6. Before writing a new or revised spec, agree the stage graph (nodes, `from`/`foreach.from`/`reduce.from`/support edges, read/write policy, schemas, and helpers) with the user when those choices are not already explicit.

## Authoring workflow

When creating or changing a workflow:

1. Identify the workflow goal and whether an existing workflow definition can be reused or adapted.
2. Choose the workflow graph first: subagent stages plus support nodes where needed. Use `type: "dynamic"` only when static `foreach`/`dag`/`reduce` shapes cannot know the child work until runtime.
3. If one of the local scaffolds fits, copy it from `./scaffolds/` to the target workflow directory and adapt the copied files. Available scaffolds: `foreach-reduce`, `support-partition`, `dag-required-reads`, `matrix-dag`, and `object-tool-fallback`.
4. Define every data dependency explicitly.
5. Add `output.controlSchema` JSON Schema files for model outputs consumed by later stages; long prose belongs in `<analysis>`, not `<control>`.
6. Set tool ceilings and read/write policy.
7. Keep helper/controller code bundle-local and trusted: `support.uses`, `dynamic.uses`, and dynamic helper refs must start with `./`, use supported bundle-local extensions, and stay inside the workflow bundle.
8. Validate with `/workflow validate <workflow-or-file>`.
9. Do not ignore validation warnings. Treat a `foreach` path warning (the path's top-level key is not a property of the source stage's control schema) as a likely typo that would fan out over nothing at runtime, and fix the path or the source schema. Treat a readOnly-with-mutation-tools warning (a stage declares `readOnly: true` but keeps a mutation-capable tool such as `bash`) as intentional only when the stage relies on worktree isolation; otherwise remove the tool.
10. Report the exact validation result, every warning, and any remaining safety notes.

## Scaffold usage

Scaffolds under `./scaffolds/` are validate-ready starter bundles for common topologies. Use them to reduce JSON-shape mistakes, then adapt the copy to the user's workflow.

- `foreach-reduce/`: parallel mapping or planning, reduce to work items, foreach verification, final report.
- `support-partition/`: collect candidates, foreach verifier, deterministic support partition/dedup, final report.
- `dag-required-reads/`: nested DAG with `outputFrom` and downstream `inputPolicy.requiredReads`.
- `matrix-dag/`: parallel lens DAG with join reducers and final required artifact read.
- `object-tool-fallback/`: read-only extraction with object-form optional tool metadata and fallback tool.

Scaffold rules:

1. Copy the scaffold to the target workflow directory before editing; do not mutate the scaffold in place for a user-specific workflow.
2. Rename the workflow, stage ids, schema files, prompts, and control fields to match the user task.
3. Keep every data dependency explicit after renaming.
4. Re-run `/workflow validate <copied-spec>` after adaptation and resolve every warning.

## Control schema and output gotchas

- Workflow specs are JSON-only; `.yaml` and `.yml` specs are not supported.
- Keep `<control>` small and machine-readable. Put detailed reasoning, evidence, and caveats in `<analysis>`.
- Add `output.controlSchema` for any model output consumed by `foreach.from`, support helpers, reducers, loop conditions, or downstream deterministic checks.
- The supported JSON Schema subset is intentionally limited. Avoid `$ref`, `$defs`, `definitions`, and `pattern`; use simple `type`, `required`, `properties`, `items`, `enum`, `const`, bounds, `additionalProperties`, and simple combinators supported by the validator.
- Make downstream paths match schema properties exactly. A typo in `$.items` or another `foreach.from` path can fan out over nothing.
- `inputPolicy.requiredReads` proves workflow-artifact reads, not semantic understanding. Use it as an access/evidence gate, not as a substitute for a good prompt or reducer.

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
- Every `foreach.from`, `reduce.from`, support `from`, and `dag.outputFrom` reference resolves.
- Every downstream-consumed control field has a schema and a bounded prompt contract.
- Support helper paths are bundle-local, `.mjs`, and trusted.
- Write-capable workflows document worktree policy, protected-path expectations, and validation/check stages.
- Runtime task examples include scope, exclusions, final artifact, and success metric.

## Promotion checklist

For a workflow promoted from local experiment to bundled/reusable package workflow:

- Move from `.pi/workflows/<name>.json` or a scratch bundle to `workflows/<name>/spec.json` with schemas/helpers in the bundle directory.
- Update `workflows/README.md` and `docs/usage.md`; update `README.md` if the workflow is user-facing.
- Add or update tests when the bundled workflow list, package contents, schema behavior, helper behavior, or docs examples are expected to remain stable.
- Run at least `/workflow validate <name-or-path>` and the relevant project checks (`npm test`, `npm run typecheck`, `npm run e2e`, or `npm run pack:dry`) when package surface changes require them.

## Response expectations

When authoring or reviewing a workflow, report:

- which existing workflow was used or why none fit,
- the stage graph,
- every `foreach.from`, `reduce.from`, and support `from` data dependency,
- write-capable stages and worktree policy,
- required agents and tool ceilings,
- `output.controlSchema` files and workflow control fields used by downstream stages,
- exact validation command and result,
- every validation warning and how it was resolved or why it is acceptable,
- any blockers before running the workflow.
