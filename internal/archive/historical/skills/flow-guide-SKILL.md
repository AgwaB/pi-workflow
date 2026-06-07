> Historical archive. Non-authoritative. Preserved for recovery context only.
> Current public terminology is workflow / workflow spec / workflow file / workflow run.

---
name: workflow-guide
description: Use whenever creating, modifying, reviewing, or running workflows via pi-workworkflows.
---

# Flow Guide

Use this skill before creating, editing, or reviewing a `/workflow` workflow.

## Required First Step

Read the package authoring guide before giving workflow advice:

- `../../docs/workflow-authoring.md`

Resolve the path relative to this skill directory. Use the guide as the source of truth for stage-first semantics, workflow selection, continuation rules, write-safety policy, and validation checklists.

## Minimum Rules To Apply

Even in short answers, enforce these rules from the guide:

- Prefer existing workworkflows/examples before inventing topology.
- Stage order controls scheduling only; it does **not** pass prior output into a later plain `task` prompt.
- If a stage needs prior output, use `reduce.from` or `foreach.from`.
- For scout-then-implement, use a write-capable `reduce` stage from scout, not a plain implementation `task`.
- In schemaVersion 1 workflows, `type`, `from`, `sourcePolicy`, and `inject` are stage fields, not nested task fields.
- Continuation belongs on the stage that may emit top-level `nextFlowWorkflow`; continuation stages require `output.format: "json"`.
- `foreach` expands all extracted items; `maxConcurrency` is only a concurrency/refill limit.
- Agent-declared tools are the authority ceiling; workflow `tools` only narrow them.
- Before implementation, migration, package-readiness, or validation-heavy flows, ask one broad sensitive-work policy question unless the user already specified it: should sensitive work proceed automatically within the current scope, ask when needed, or stay blocked? Examples: dependency install, broad file edits, long/expensive validation, package/audit commands.
- Capture the selected sensitive-work policy in the runtime task or workflow stage prompts. Publish/deploy/push/upload, secrets, and external mutations still require separate explicit approval.
- Write-capable stages need explicit `worktreePolicy`, rollback/checkpoint, protected paths, and validation commands.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- When a skill creates a reusable project workflow, save it under `.pi/workworkworkflows/<name>.json`.
- Always run `/workflow validate <workflow-or-file>` before handing off a workflow, and run schemaVersion 1 workflows as `/workworkflow run <workflow> "<task>"`.

## Workflows

When the user asks to run a workflow or background task:

1. Use the closest matching bundled workflow:
   - Research: `code-research` or `deep-research`
   - Review: `review`
   - Migration: `migration`
   - Implementation: `implementation-slice`
2. Run via `/workworkflow run <workflow> "<task>"`
3. Do not attempt to run workflows manually or via other tools when a workflow covers the task.

## Response Expectations

When authoring or reviewing a workflow, report:

- that you used `docs/workflow-authoring.md`,
- the exact scheduling rule when relevant: stage order controls scheduling only and does not pass prior output into a later plain task,
- which existing workflow/example was used or why none fit,
- whether every data dependency has `reduce.from` or `foreach.from`,
- write-capable stages and their worktree policy,
- sensitive-work policy and whether it was provided by the user or needs asking,
- continuation mode/limits if present,
- exact validation command and result,
- any blockers or safety notes before running.
