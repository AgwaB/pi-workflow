# Plan: Recipe Templates + Runtime Task Injection

## Goal

Make `pi-subagent-flow` recipes reusable workflow templates. A recipe defines the
structure and roles only; the concrete task is supplied at runtime:

```text
/flow run <recipe> "<task>"
```

There is no separate "spec" concept. A recipe IS the executable template; the task
is injected into the stages that declare `inject: true`.

## Confirmed decisions

```text
- recipe = structure-only template (schemaVersion 2 stage-first JSON)
- task   = supplied at runtime on the /flow run command line
- prompt = each stage's role text (target-independent, e.g. "the given target")
- agent  = unchanged; injected as system prompt (already works)
- inject = stage-level boolean: should the runtime task be injected for this stage?
- entry stages (no `from`) always receive the task (inject implicit true)
- non-entry stages default inject = false (avoid verification bias)
- summarization of the task is left to the subagent, not the runtime
- brief files (REVIEW_TARGET.md, DEEP_RESEARCH_BRIEF.md) are removed
- /flow run <recipe> with no task is rejected (D4)
- recipe names are run directly; explicit paths still resolve through the existing loader, but there is no separate `.pi/flow-specs/` concept
```

## Layering (where each piece goes)

```text
agent  -> system prompt   (--append-system-prompt)  [already implemented]
prompt -> user prompt     (recipe stage role)        [already implemented]
task   -> user prompt     (injected when inject)     [NEW]
```

Final compiled user prompt for an inject-eligible stage (header renamed per C3):

```text
# Task
<runtime task>

# Instructions
<recipe stage prompt>
... # Output Format / # Constraints / source(from) context ...
```

## Injection rule

```text
For each stage:
  effectiveInject =
    explicit `inject` if present
    else true  if stage is an ENTRY stage (no incoming data dependency)
    else false

If effectiveInject is true, prepend a "# Task\n<task>" block ABOVE the stage prompt.
```

### Entry detection (F3 — required)

Do NOT use raw `from === undefined`. reduce/foreach default `from` to the previous
stage when omitted, so a naive check wrongly treats a downstream reduce as entry and
injects the task into verification/synthesis (bias).

```text
Entry stage = a stage with no incoming data dependency in the normalized graph.
  task / parallel : entry when no producing predecessor (normally yes).
  reduce / foreach: NEVER entry (always consume prior output, even if `from` omitted).
```

### Prompt assembly order (F8 — fixed)

```text
1. # Task           (only if effectiveInject)
2. # Instructions   (stage role prompt)   <- renamed from "# Flow Task" (C3)
3. # Output Format  (if any)
4. # Constraints
5. source/from context (reduce source-stage context, etc.)
```

Decisions (resolved):
- O1: a task is ALWAYS required for a schemaVersion 2 recipe run; no task -> reject.
- O2: `inject` is stage-level only. No per task-item / per `each` inject.
- O3: a parallel stage's `inject` applies to all of its tasks.
- O4: the injected `# Task` block goes ABOVE the stage prompt.
- F7: entry stages DEFAULT inject=true; explicit `inject: false` overrides.

A foreach stage always has `from`, so it is never an entry stage and defaults
`inject: false`.

### Task storage + foreach interpolation collision (F2 — critical)

foreach interpolates `${...}` over the compiled prompt at runtime. If the task is
injected at compile time and contains `${...}`, braces, or code, runtime
interpolation throws and halts the flow.

```text
- Persist the runtime task on the compiled flow + run record (task: string).
- task stage / parallel stage / reduce stage: inject the # Task block at COMPILE time
  (no later ${...} interpolation runs over these prompts).
- foreach: do NOT inject at compile time. Prepend the # Task block at RUNTIME, AFTER
  ${item} interpolation, in the foreach task preparation path.
```

## Changes by file

### 1. `src/schema.ts`
- Add `inject` (boolean) at STAGE level only:
  - `STAGE_FIRST_TASK_STAGE_KEYS`
  - `STAGE_FIRST_REDUCE_STAGE_KEYS`
  - `STAGE_FIRST_FOREACH_STAGE_KEYS` (stage-level, not on `each`)
  - `STAGE_FIRST_PARALLEL_STAGE_KEYS` (applies to all its tasks)
- Do NOT add `inject` to `STAGE_FIRST_TASK_ITEM_KEYS` or `STAGE_FIRST_EACH_KEYS`.
- Validate `inject` is boolean when present. Not required.

### 2. `src/types.ts`
- Add optional `inject?: boolean` to STAGE types only (not task-item / each) (F9).
- Add `task: string` to the compiled stage-first flow + run record (for foreach
  runtime injection, F2).

### 3. `src/compiler.ts`
- Accept a required non-empty `task` in `compileStageFirstFlowSpec(spec, { cwd, task })`.
- Compute `effectiveInject` using normalized entry detection (F3), not `from` presence.
- Rename the stage prompt header `# Flow Task` -> `# Instructions` (C3).
- For task/parallel/reduce stages: when inject, prepend `# Task` at compile time.
- For foreach: store the task; DO NOT inject at compile time (F2).
- Persist `task` on the compiled flow so the runtime can inject into foreach items.

### 3b. `src/engine.ts` (foreach runtime injection, F2)
- In the foreach task preparation path, after `${item}` interpolation, prepend the
  `# Task` block when the foreach stage's effectiveInject is true.

### 4. `src/engine.ts`
- `runFlowSpec(specPath, cwd, task)` accepts and forwards the task.
- Enforce the required-task rule at this run boundary (F5) for schemaVersion 2;
  v1 specs do not take a runtime task.

### 5. `src/extension.ts`
- `/flow run <recipe> <task...>`: first token is the recipe name/path; the REST is the
  task, parsed from the RAW args string after the recipe token so whitespace,
  newlines, and code blocks are preserved (F4). Do not `splitArgs`+join the task.
- Trim ends; reject whitespace-only task (F4/F5).
- Pass the task to `runFlowSpec`.
- Update help text and `FLOW_HELP`.

### Recipe name/path resolution (resolver clarity)
- `<recipe>` resolves via existing recipe registries (`flows/`, `.pi/flow-recipes/`,
  `~/.pi/agent/flow-recipes/`) or an explicit path, as today.
- There is no `.pi/flow-specs/` concept (pre-release, no legacy — C1).
- A recipe-not-found case keeps the current fail-closed error.

### 6. Recipes (`flows/*.json`) — staged, see below
- Rewrite prompts to be target-independent ("the given target", roles).
- Remove brief-file reads.
- Add `inject` only where non-default (e.g. `synthesize` reduce → `inject: true`).

## D4 enforcement detail

`/flow run <recipe>` with no task text is always rejected for schemaVersion 2 recipes,
at the run boundary (F5/O1):

```text
reject: "This recipe needs a task. Usage: /flow run <recipe> \"<task>\""
```

Validation may compile without a task, but run callers must pass a non-empty task before launch.

## Legacy cleanup (C1 — pre-release, no back-compat)

The project is unreleased; there is no legacy surface to preserve. Rather than
"protect v1":
- The `inject`/task model targets schemaVersion 2 recipes.
- v1 specs and smoke recipes that relied on baked tasks (e.g. `quick-check`) are
  updated to the v2 recipe+task model or moved to `flows/examples/` as needed.
- Brief files (`REVIEW_TARGET.md`, `DEEP_RESEARCH_BRIEF.md`) are removed entirely.
- No dual-mode/migration shim.

## Deferred (C2 — must do later, not in this change)

- Rename `runFlowSpec` / `compileStageFirstFlowSpec` (and related "FlowSpec" names)
  to drop the retired "spec" wording. Tracked as a required follow-up, not optional.

## Test/validation impact

- `test/unit.test.mjs`: add cases for
  - schema accepts `inject` on stages; REJECTS `inject` on task-item / each (F9),
  - schema rejects non-boolean `inject`,
  - compiler entry detection: reduce/foreach with omitted `from` are NOT entry (F3),
  - compiler injects `# Task` only into effective-inject stages, in the fixed order (F8),
  - entry stage with explicit `inject: false` is NOT injected (F7),
  - non-entry reduce with `inject: true` IS injected,
  - compiler/run rejects missing or whitespace-only task — ALWAYS, not conditionally (F5),
  - task containing `${...}`/braces survives a foreach run (F2 regression).
- `e2e-test/`: scenarios that ran recipes by name with fixed task text move to
  `/flow run <recipe> "<task>"`. Update `quick-check` to take a task.
- Remove e2e dependence on `REVIEW_TARGET.md` / `DEEP_RESEARCH_BRIEF.md`.

## Build order (agreed Q2)

```text
Phase 1 — Engine (this plan's core)
  1. schema: add `inject`
  2. types: add inject + task plumbing
  3. compiler: effectiveInject + task block + reject-missing-task
  4. engine/extension: /flow run <recipe> "<task>" plumbing + help
  5. unit tests for the above
  verify: npm run typecheck && npm test

Phase 2 — One recipe end to end
  6. rewrite deep-review to target-independent + inject flags
  7. remove its brief-file reads
  8. live run: /flow run deep-review "<task>" and inspect injection
  verify: stage prompts show task only where expected

Phase 3 — Remaining recipes
  9. rewrite each recipe to target-independent templates
  10. move baked, project-specific content into flows/examples/
  11. update e2e scenarios + smoke

Phase 4 — A/B eval redesign
  12. redesign .pi/eval/ab-execution so arm A = recipe + task,
      arm B = single agent + same task (truly same input)
```

## Open questions — RESOLVED

```text
O1. Reject no-task for all v1 recipes. (task always required)
O2. inject is stage-level only (no per-each).
O3. Parallel stage inject applies to all its tasks.
O4. Injected task block goes ABOVE the stage prompt.
```

## Panel review follow-ups — RESOLVED

From run `.pi/skill-runs/review/run_20260603_181142_01ebfc80` (kimi/gpt-5.5/agy):

```text
F1 doc contradiction        -> flow-recipe-model.md rewritten to recipe=executable.
F2 ${item} collision        -> foreach injects at runtime after interpolation; task persisted.
F3 entry detection          -> normalized graph; reduce/foreach never entry.
F4 CLI task formatting       -> parse task from raw args; preserve newlines; reject blank.
F5 D4 consistency            -> required task enforced at run boundary + compiler; tests fixed.
F6 v1 backward-compat        -> reframed by C1: no legacy; v1/smoke updated, not protected.
F7 entry inject wording      -> default true, explicit false overrides.
F8 prompt assembly order      -> fixed order documented.
F9 inject scope              -> stages only; schema rejects on item/each.

C1 schemaVersion bump        -> NO bump; pre-release, remove legacy instead.
C2 rename FlowSpec funcs      -> deferred, but REQUIRED follow-up.
C3 header rename             -> "# Flow Task" -> "# Instructions".
C4 entry-auto vs explicit     -> keep entry-auto; robustness comes from F3.
```
