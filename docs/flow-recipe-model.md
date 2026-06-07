# Flow Recipe Model

Confirmed terminology and execution model for `pi-subagent-flow`.

Status: pre-release. There is no legacy/back-compat surface to preserve; the model
below is the single source of truth.

## Core model

```text
recipe = a reusable, structure-only workflow template (schemaVersion 2 stage-first).
         It defines stages, roles, data flow, and task-injection policy.
         It is the executable unit.
task   = the concrete subject, supplied at runtime on the command line.
```

There is NO separate "spec" concept and no `.pi/flow-specs/` artifact. A recipe is run
directly with a task:

```text
/flow run <recipe> "<task>"
```

## Recipe authoring rule

A recipe must be target-independent:

- stage prompts describe the method/role, not a concrete subject
  (e.g. "Review the given target", not "Review src/engine.ts"),
- no project-specific content baked into prompts,
- no brief files (REVIEW_TARGET.md / DEEP_RESEARCH_BRIEF.md). The task arrives at runtime.

If a recipe hardcodes a concrete subject, it belongs in `flows/examples/`, not `flows/`.

## How the three inputs combine

```text
agent  -> subagent system prompt        (already implemented)
prompt -> stage role text (user prompt)  (recipe)
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
- task is REQUIRED for every recipe run; no task -> reject.
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
flows/              recipe templates (run target)
flows/examples/     examples: a recipe applied to a concrete target (reference only)
```

## Command behavior

```text
/flow run <recipe> "<task>"   run a recipe template against a task (the run path)
/flow run <recipe>            reject: a task is required
/flow recipe list/show        browse recipe templates
/flow recommend "<task>"      suggest which recipe template fits the task
```

## Implementation references

See `docs/flow-task-injection-plan.md` for the staged implementation plan
(schema/types/compiler/engine/extension changes, tests, and recipe rewrites).
