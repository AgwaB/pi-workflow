---
name: workflow-guide
description: Create, modify, review, or choose pi-workflow workflow definitions. Use when the user asks to build/customize a /workflow workflow, validate a workflow spec, choose workflow stage topology, decide which workflow fits a task (including vague or ambiguous requests where the workflow should be clarified and recommended collaboratively), or explain pi-workflow authoring rules.
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
- Public `schemaVersion: 1` workflow specs use `artifactGraph.stages`.
- Stage order controls scheduling only; it does **not** pass prior output into a later plain `single` stage.
- If a stage needs prior artifacts, use `reduce.from`, `foreach.from`, or support `from`.
- For dynamic fan-out, use `foreach.from` with a simple dot path into upstream `control.json`.
- For synthesis/fan-in, use `reduce.from` and require/encourage `workflow_artifact` reads for detailed upstream artifacts.
- For deterministic local post-processing, declare a `support` object with `support.uses` pointing to a bundle-local `./*.mjs` helper; support is trusted local code, not sandboxed subagent work and does not use a separate `type` value.
- For bounded iteration, use `loop` with fixed child stages, `maxRounds`, and deterministic `until`.
- Agent-declared tools are the authority ceiling; workflow `tools` can only narrow them.
- Keep review/research workflows read-only unless the workflow explicitly documents managed-worktree mutation.
- Write-capable workflows need explicit worktree policy, validation/check stages, and protected-path awareness.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- Project workflows should be saved under `.pi/workflows/<name>.json` or a bundle directory with `spec.json`, schemas, and helpers.
- For natural-language execution of existing workflows, prefer `workflow_list` and `workflow_run` when those tools are available; use `/workflow ...` commands as the deterministic manual fallback.
- Always run `/workflow validate <workflow-or-file>` before handing off or running a reusable workflow.

## Intake (run before authoring when the request is ambiguous)

When the request is vague, broad, delegated ("just pick a good one"), or self-contradictory, do not write a spec yet. Clarify and recommend first, then build collaboratively.

1. Do not generate a spec on an underspecified request. Surface what is missing instead of guessing.
2. Survey existing options with `workflow_list` when available, otherwise `/workflow list`, and read each candidate's `description` and stage graph; present the top candidates and what each is for.
3. Ask the user the decisions that determine the graph, only the ones still unknown:
   - What is inspected/produced, and what decision does the output support?
   - Read-only review/research, or write-capable (managed worktree)?
   - Fixed parallel stages, or dynamic fan-out (`foreach`) over an upstream list?
   - Which agents must exist, and what tool ceiling do they allow?
4. If a bundled or existing project workflow fits, recommend it and stop; do not invent a new topology.
5. If the request is contradictory (for example "read-only" plus "edit and commit"), name the conflict and offer concrete alternatives rather than silently resolving it. Workflow workers do not commit; mutation goes through a managed worktree for human review with no auto-merge.
6. If a new workflow is needed, agree the stage graph (nodes, `from`/`foreach.from`/`reduce.from` edges, read/write policy) with the user before writing the spec, then continue with Authoring.

## Authoring workflow

When creating or changing a workflow:

1. Identify the user goal and whether a bundled workflow already fits.
2. Choose the workflow graph first: subagent stages plus support nodes where needed.
3. Define every data dependency explicitly.
4. Add `output.controlSchema` JSON Schema files for model outputs consumed by later stages; long prose belongs in `<analysis>`, not `<control>`.
5. Set tool ceilings and read/write policy.
6. Validate with `/workflow validate <workflow-or-file>`.
7. Do not ignore validation warnings. Treat a `foreach` path warning (the path's top-level key is not a property of the source stage's control schema) as a likely typo that would fan out over nothing at runtime, and fix the path or the source schema. Treat a readOnly-with-mutation-tools warning (a stage declares `readOnly: true` but keeps a mutation-capable tool such as `bash`) as intentional only when the stage relies on worktree isolation; otherwise remove the tool.
8. Report the exact validation result, every warning, and any remaining safety notes.

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
