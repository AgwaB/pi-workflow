---
name: workflow-guide
description: Create, modify, or review pi-workflow workflow definitions. Use when the user asks to build/customize a /workflow workflow, validate a workflow spec, choose workflow stage topology, or explain pi-workflow authoring rules.
---

# Workflow Guide

Use this skill before creating, editing, or reviewing a `pi-workflow` workflow.

## Required first step

Read the public usage guide and bundled workflow notes before giving workflow-authoring advice:

- `../../docs/usage.md`
- `../../workflows/README.md`

Resolve paths relative to this skill directory. Treat those docs as the source of truth for command surface, workflow resolution, stage-first semantics, safety policy, and validation.

## Core rules

- Prefer a bundled workflow before inventing a new topology.
- Stage order controls scheduling only; it does **not** pass prior output into a later plain `task` stage.
- If a stage needs prior output, use `reduce.from` or `foreach.from`.
- For dynamic fan-out, use `foreach.from` with a JSON path into a prior stage's structured output.
- For synthesis/fan-in, use `reduce.from` and Source Stage Context.
- For deterministic local post-processing, use `transform` with a bundle-local `./*.mjs` helper.
- For bounded iteration, use `loop` with fixed child stages, `maxRounds`, and deterministic `until`.
- Agent-declared tools are the authority ceiling; workflow `tools` can only narrow them.
- Keep review/research workflows read-only unless the workflow explicitly documents managed-worktree mutation.
- Write-capable workflows need explicit worktree policy, validation/check stages, and protected-path awareness.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- Project workflows should be saved under `.pi/workflows/<name>.json`.
- Always run `/workflow validate <workflow-or-file>` before handing off or running a reusable workflow.

## Authoring workflow

When creating or changing a workflow:

1. Identify the user goal and whether a bundled workflow already fits.
2. Choose the stage graph first.
3. Define every data dependency explicitly.
4. Add JSON output contracts for model outputs consumed by later stages.
5. Set tool ceilings and read/write policy.
6. Validate with `/workflow validate <workflow-or-file>`.
7. Report the exact validation result and any remaining safety notes.

## Response expectations

When authoring or reviewing a workflow, report:

- which existing workflow was used or why none fit,
- the stage graph,
- every `foreach.from` and `reduce.from` data dependency,
- write-capable stages and worktree policy,
- required agents and tool ceilings,
- output contracts used by downstream stages,
- exact validation command and result,
- any blockers before running the workflow.
