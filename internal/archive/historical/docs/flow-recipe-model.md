> Historical archive. Non-authoritative. Preserved for recovery context only.
> Current public terminology is workflow / workflow spec / workflow file / workflow run.

# Workflow Model

Confirmed terminology and execution model for `pi-workflow`.

Status: pre-release. There is no legacy/back-compat surface to preserve; the model
below is the single source of truth.

## Core model

```text
workflow = a reusable, structure-only workflow template (schemaVersion 2 stage-first).
         It defines stages, roles, data flow, and task-injection policy.
         It is the executable unit.
task   = the concrete subject, supplied at runtime on the command line.
```

There is NO separate "spec" concept and no `.pi/workflow-specs/` artifact. A workflow is run
directly with a task:

```text
/workworkflow run <workflow> "<task>"
```

## Workflow authoring rule

A workflow must be target-independent:

- stage prompts describe the method/role, not a concrete subject
  (e.g. "Review the given target", not "Review src/engine.ts"),
- no project-specific content baked into prompts,
- no brief files (REVIEW_TARGET.md / DEEP_RESEARCH_BRIEF.md). The task arrives at runtime.

If a workflow hardcodes a concrete subject, it belongs in `workflows/examples/`, not `workflows/`.

## How the three inputs combine

```text
agent  -> subagent system prompt        (already implemented)
prompt -> stage role text (user prompt)  (workflow)
task   -> injected user-prompt block     (runtime, where inject applies)
```

Compiled user prompt for an inject-eligible stage:

```text
# Task
<runtime task>

# Instructions
<stage role prompt>
... output format / constraints / source data ...
```

## Task injection policy

```text
- task is REQUIRED for every workworkflow run; no task -> reject.
- entry stages (no incoming data dependency) inject the task by default.
- non-entry stages (reduce/foreach and any stage that consumes prior output)
  do NOT inject by default, to avoid verification bias.
- a stage may set inject: true/false explicitly to override the default.
- inject is a STAGE-level flag only (not per task-item, not per foreach each).
- a parallel stage's inject applies to all of its tasks.
```

Entry detection uses the normalized dependency graph, not raw `from` presence:
reduce/foreach consume prior output and are never entry stages, even when `from` is
omitted (omitted `from` defaults to the previous stage).

## Locations

```text
workflows/              workflow templates (run target)
workflows/examples/     examples: a workflow applied to a concrete target (reference only)
```

## Command behavior

```text
/workworkflow run <workflow> "<task>"   run a workflow template against a task (the run path)
/workworkflow run <workflow>            reject: a task is required
/workworkflow list/show        browse workflow templates
/workflow recommend "<task>"      suggest which workflow template fits the task
```

## Implementation references

See `docs/workflow-task-injection-plan.md` for the staged implementation plan
(schema/types/compiler/engine/extension changes, tests, and workflow rewrites).
