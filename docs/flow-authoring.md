# Flow Authoring Guide

This guide is the package-level reference for creating, modifying, and reviewing `pi-subagent-flow` recipes.

Use it when an agent is asked to write a new `/flow` recipe. The goal is to avoid ad-hoc workflows that look reasonable but do not match the stage-first execution model.

## Quick Start

Prefer existing recipes before writing custom recipes:

| Goal | Start from |
|---|---|
| Migration discovery/planning | `flows/migration.json` |
| Bounded implementation batch | `flows/implementation-slice.json` |
| Review with finding validation | `flows/review.json` |
| Research → verify → synthesize | `flows/deep-research.json` |
| Isolated alternatives / best-of-n fix | `flows/best-of-n-fix.json` |
| Minimal stage-first example | `examples/stage-first.json` |

Validate every recipe before suggesting it be run:

```text
/flow validate <recipe-path-or-name>
```

Run from the intended project root:

```text
/flow run <recipe-name-or-path> "<task>"
/flow view
/flow wait <run-id>
/flow show <run-id>
```

## Stage-First Mental Model

`schemaVersion: 2` is the launch contract for new workflows.

A stage-first flow is a sequential composition of stages:

```json
{
  "schemaVersion": 2,
  "agent": "scout",
  "readOnly": true,
  "tools": ["read", "grep", "find", "ls"],
  "flow": {
    "stages": [
      { "id": "inspect", "type": "task", "prompt": "Inspect the repo." },
      { "id": "summary", "type": "reduce", "from": "inspect", "prompt": "Summarize Source Stage Context." }
    ]
  }
}
```

Important rule:

> Stage order controls scheduling only. It does **not** automatically pass prior output into a later plain `task` prompt.

If a stage must use earlier output, use one of the explicit source mechanisms:

- `reduce.from` to consume source-stage context.
- `foreach.from` to expand structured output items.

## Runtime Task Injection

Recipes are reusable templates. Keep stage prompts target-independent and put the concrete user request in the runtime task:

```text
/flow run review "Review the current diff for correctness and regressions."
```

Stage-first prompt assembly uses:

```text
# Task
<runtime task>

# Instructions
<stage prompt>
```

Rules:

- `inject` is a stage-level boolean only.
- Entry `task` and `parallel` stages inject the runtime task by default.
- `reduce` and `foreach` stages default to no task injection to avoid verification bias.
- Set `inject: false` on an entry stage to suppress default injection.
- Set `inject: true` on a non-entry synthesis stage when it needs the original task for framing.
- Do not add `inject` to parallel task items or `foreach.each`.

## Stage Types

### `task`

Use for a single independent subagent task.

```json
{
  "id": "inspect",
  "type": "task",
  "output": { "format": "markdown" },
  "prompt": "Inspect the package and report risks."
}
```

A `task` stage can run after previous stages, but it does not receive their outputs unless those outputs are manually described in its prompt or the stage is changed to a `reduce` stage.

### `parallel`

Use for static fan-out with known tasks.

```json
{
  "id": "reviewers",
  "type": "parallel",
  "maxConcurrency": 3,
  "output": { "format": "json", "requiredKeys": ["findings"] },
  "tasks": [
    { "id": "runtime", "prompt": "Review runtime correctness. Return JSON with findings." },
    { "id": "safety", "prompt": "Review safety. Return JSON with findings." },
    { "id": "product", "prompt": "Review product fit. Return JSON with findings." }
  ]
}
```

If `maxConcurrency` is omitted, stage-first `parallel` defaults to `10`.

### `foreach`

Use for dynamic fan-out from previous JSON structured output.

```json
{
  "id": "verify",
  "type": "foreach",
  "from": { "stage": "research", "path": "$.claims", "mode": "concat" },
  "maxConcurrency": 4,
  "output": { "format": "json", "requiredKeys": ["claim", "status"] },
  "each": {
    "prompt": "Verify this claim: ${item}. Return JSON with claim, status, evidence."
  }
}
```

Rules:

- `foreach.from` is required.
- `from.path` is a simple path like `$.claims`.
- Use `mode: "concat"` when reading arrays from a multi-task source stage.
- `foreach` expands **all** extracted items.
- `maxConcurrency` controls how many generated tasks run at once; it is not an item cap.
- If semantic merge/dedupe/ranking is needed, add a separate `reduce` stage. `concat` is mechanical only.

### `reduce`

Use for fan-in and source-stage context passing.

```json
{
  "id": "report",
  "type": "reduce",
  "from": ["reviewers", "validate"],
  "sourcePolicy": "partial",
  "output": { "format": "markdown" },
  "prompt": "Use Source Stage Context to produce the final report."
}
```

Rules:

- `reduce` consumes bounded source-stage context: statuses, artifact paths, structured previews, and output previews.
- `from` may be a string or array of prior stage ids.
- If `from` is omitted, it consumes the immediately previous stage.
- `sourcePolicy: "require-success"` is the default and blocks/skip behavior when required sources fail.
- Use `sourcePolicy: "partial"` only when degraded synthesis is acceptable and the prompt says how to handle missing/failed sources.

## Context-Passing Patterns

### Scout Then Implement

Do **not** use this if implementation must use scout output:

```json
{
  "id": "scout",
  "type": "task",
  "prompt": "Find what to change."
},
{
  "id": "implement",
  "type": "task",
  "readOnly": false,
  "prompt": "Implement the scout findings."
}
```

The implementation prompt will not automatically receive scout output.

Use a write-capable `reduce` stage instead:

```json
{
  "id": "scout",
  "type": "task",
  "readOnly": true,
  "tools": ["read", "grep", "find", "ls"],
  "output": { "format": "markdown" },
  "prompt": "Inspect the target and produce a concise implementation checklist."
},
{
  "id": "implement",
  "type": "reduce",
  "from": "scout",
  "sourcePolicy": "require-success",
  "agent": "delegate",
  "readOnly": false,
  "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
  "worktreePolicy": "on",
  "output": { "format": "markdown" },
  "prompt": "Use Source Stage Context. Implement only the scoped checklist. Report changed files and validation."
}
```

### Research Then Verify Claims

Use JSON output from research and a `foreach` verification stage:

```json
{
  "id": "research",
  "type": "parallel",
  "output": { "format": "json", "requiredKeys": ["claims"] },
  "tasks": [
    { "id": "api", "prompt": "Return JSON with claims about APIs." },
    { "id": "runtime", "prompt": "Return JSON with claims about runtime behavior." }
  ]
},
{
  "id": "verify",
  "type": "foreach",
  "from": { "stage": "research", "path": "$.claims", "mode": "concat" },
  "maxConcurrency": 4,
  "output": { "format": "json", "requiredKeys": ["claim", "status", "evidence"] },
  "each": { "prompt": "Verify claim: ${item}." }
}
```

### Review Then Validate Findings

Use `parallel` reviewers, `foreach` finding validation, and a final `reduce`:

```json
{
  "id": "reviewers",
  "type": "parallel",
  "output": { "format": "json", "requiredKeys": ["findings"] },
  "tasks": [
    { "id": "runtime", "prompt": "Return JSON with findings." },
    { "id": "safety", "prompt": "Return JSON with findings." }
  ]
},
{
  "id": "validate",
  "type": "foreach",
  "from": { "stage": "reviewers", "path": "$.findings", "mode": "concat" },
  "output": { "format": "json", "requiredKeys": ["finding", "verdict"] },
  "each": { "prompt": "Validate this finding against repository evidence: ${item}." }
},
{
  "id": "report",
  "type": "reduce",
  "from": ["reviewers", "validate"],
  "sourcePolicy": "partial",
  "prompt": "Keep only evidence-backed findings with realistic impact."
}
```

## Continuation Rules

Continuation is for bounded follow-up child flows generated by a stage.

Use continuation only when a workflow may need another bounded round after synthesis, such as deep research discovering a blocking evidence gap.

Rules:

- Continuation is stage-local: put `continuation` on the stage that may emit `nextFlowSpec`.
- In the current launch contract, continuation belongs on a `reduce` stage.
- A continuation stage must set `output.format: "json"`.
- `/flow` inspects the continuation stage's structured output for top-level `nextFlowSpec`.
- If no `nextFlowSpec` is present, the run becomes final.
- Generated child specs must be `schemaVersion: 2` and validate before launch.
- The active graph is never mutated in place. Continuation creates a linked child run and saves generated spec artifacts.
- Prefer `mode: "ask"` unless auto-launch is clearly safe, read-only, and bounded.
- `mode: "ask"` records `awaiting_approval`; the user launches the child with `/flow continue <run-id>`.
- `mode: "auto"` validates and launches the child without a manual approval step, within configured limits.
- Always set `maxRound`, `maxGeneratedTasks`, and `maxTasksPerRound`.
- Use `allowedAgents` and `allowedTools` to narrow generated child authority.

Example:

```json
{
  "id": "final",
  "type": "reduce",
  "from": ["research", "verify"],
  "sourcePolicy": "partial",
  "output": { "format": "json", "requiredKeys": ["finalReport"] },
  "continuation": {
    "mode": "ask",
    "maxRound": 3,
    "maxGeneratedTasks": 12,
    "maxTasksPerRound": 6,
    "allowedAgents": ["scout"],
    "allowedTools": ["read", "grep", "find", "ls"],
    "onInvalidGeneratedSpec": "block"
  },
  "prompt": "Produce finalReport. Include nextFlowSpec only when a blocking evidence gap remains. Otherwise omit nextFlowSpec."
}
```

Continuation output shape when follow-up is needed:

```json
{
  "finalReport": "...",
  "nextFlowSpec": {
    "schemaVersion": 2,
    "name": "follow-up-evidence-check",
    "agent": "scout",
    "readOnly": true,
    "tools": ["read", "grep", "find", "ls"],
    "flow": {
      "stages": [
        { "id": "check", "type": "task", "prompt": "Check the specific missing evidence." }
      ]
    }
  }
}
```

## Tool, Agent, and Runtime Authority

Agent declarations are the authority ceiling.

- Stage/recipe `tools` can only narrow the selected agent's declared tools.
- Recipes cannot grant tools that the agent does not declare.
- If an agent declares no tools, a recipe cannot safely grant tools to it.
- `readOnly: true` rejects non-read-only effective tools.
- `bash` is treated as mutation-capable for safety unless a future restricted-bash mode exists.
- Unknown custom tools require recipe-local `toolDefinitions` and still cannot exceed the agent ceiling.
- Delegation/orchestration tools must not be exposed to child agents.

Use exact agents and tools in write stages. Do not rely on Pi defaults for safety-sensitive flows.

## Worktree and CWD Safety

`cwd` and `worktreePolicy` are separate from prompt text.

- The flow run's project root is where `/flow run` is invoked.
- Absolute paths in prompts do not change flow artifact location or child cwd defaults.
- Tell the user exactly where to run `/flow run` from.
- `worktreePolicy: "auto"` is the default.
- In git repositories, mutation-capable tasks should normally use managed worktrees.
- `worktreePolicy: "on"` requires a managed worktree and fails closed if one cannot be created.
- `worktreePolicy: "off"` runs in the selected cwd and is a deliberate opt-out.
- In non-git workspaces, managed worktrees are unavailable; write-capable flows with `worktreePolicy: "off"` mutate the live directory.

For non-git write flows, add one of these mitigations:

- Run from a disposable copy.
- Create an external backup/checkpoint before running.
- Instruct the implementation stage to stop before overwriting existing target files.
- Restrict expected files/directories in the prompt.

## Sensitive Work Policy

Before authoring implementation, migration, package-readiness, or validation-heavy flows, ask one broad policy question unless the user already specified it:

```text
If this flow needs sensitive work, how should it proceed?
Examples: dependency install, broad file edits, long/expensive validation, package/audit commands.

- Proceed automatically within the current scope.
- Ask when needed.
- Do not run it; report a blocker.
```

Capture the answer in the runtime task or recipe prompts. This avoids repeatedly asking about predictable validation work while still preserving the user's intended boundary.

This policy does not cover publish, deploy, git push, upload, secrets, or external-system mutation. Those always require separate explicit approval.

## Output Format Guidance

Use markdown when output is only for humans.

Use JSON when:

- a later `foreach` needs arrays from the output,
- continuation may emit `nextFlowSpec`,
- a later stage or external tool needs deterministic parsing,
- the output has required keys that should be validated.

Example JSON contract:

```json
"output": { "format": "json", "requiredKeys": ["workItems"] }
```

If JSON is invalid, behavior depends on the output contract. Prefer clear prompts such as "Return JSON only" for stages that feed downstream automation.

## Recipe Catalog Metadata

Recipes may include optional top-level `catalog` metadata. It does not affect execution; it helps parent agents choose between similar deterministic recipes before calling `/flow validate` or `/flow run`.

```json
"catalog": {
  "useWhen": ["standard code review", "single reviewer"],
  "avoidWhen": ["deep panel review", "implementation or file edits"],
  "similarRecipes": ["deep-review", "focused-review"],
  "mutationRisk": "read-only",
  "naturalLanguageTriggers": ["review this change", "audit this code"]
}
```

Use short concrete phrases. Avoid putting policy or execution instructions in `catalog`; prompts and recipe fields remain the execution contract.

Agent-facing helper:

```text
/flow recommend "please do a deep review and verify findings"
```

The recommendation output is advisory and deterministic from recipe metadata. Parent agents should still explain the selected recipe when ambiguity matters.

## Recipe Selection Guidance

### Migration Planning

Use `flows/migration.json` when the task is to understand a migration and produce a staged plan.

Pattern:

```text
parallel inventory -> foreach item plans -> reduce migration plan
```

Do not add write tools to migration planning unless the user explicitly asks to implement a bounded slice.

### Implementation Slice

Use `flows/implementation-slice.json` when the task is to implement a bounded batch.

Pattern:

```text
task plan -> foreach implement in managed worktrees -> reduce review/handoff
```

For a one-off scout-then-implement flow, use the write-capable `reduce.from scout` pattern above.

### Review

Use `flows/review.json` for a standard single-review contract when the task is review-only and does not need panel validation. The bundled `review` recipe is bash-capable so it can inspect `git status`, `git diff`, and `git diff --stat`; it is review-only by prompt policy and runs in a managed worktree, but it is not a hard `readOnly: true` guarantee. A review skill wrapper should map ordinary "review this" requests here by default, then package the JSON verdict/findings into its normal review artifact.

Pattern:

```text
task review -> structured verdict/findings/evidence
```

Use `flows/deep-review.json` for thorough, panel, multi-role, multi-provider, or evidence-verification review. A review skill wrapper should choose this when the user asks for deep/thorough/panel verification or when the review target is risky enough to justify finding validation.

Pattern:

```text
parallel reviewers -> foreach validate findings -> reduce synthesize
```

Review recipes can be either hard read-only (`readOnly: true` with only read-only tools, usually requiring the diff/artifacts to be supplied) or bash-capable review-only (`bash` allowed for inspection commands, `worktreePolicy: "auto"`/`"on"`, and prompts that forbid mutation). Bash restrictions are prompt-enforced today; use a dedicated tool or supplied diff artifact when a hard command allowlist is required.

### Deep Research

Use `flows/deep-research.json` when claims should be independently verified and cited.

Pattern:

```text
parallel research -> foreach verify claims -> reduce final report with optional ask continuation
```

Keep claim counts bounded in prompts. Do not rely on hidden engine caps.

## Validation Checklist

Before handing off a recipe, report:

- recipe path or recipe name,
- run directory the user should invoke from,
- stage count and task count from `/flow validate`,
- write-capable stages,
- worktree policy for write stages,
- downstream data dependencies and their `from` fields,
- continuation mode and limits, if present,
- validation warnings or blockers,
- validation commands run and not run.

Minimum validation:

```text
/flow validate <recipe>
```

When package code changed, also run relevant project checks such as:

```bash
npm run typecheck
npm test
npm run pack:dry
```

## Common Red Flags

- A later plain `task` says "use prior findings" but has no `reduce.from`.
- `foreach` reads markdown output instead of JSON structured output.
- `foreach.maxConcurrency` is treated as an item limit.
- `mode: "auto"` continuation with broad write-capable tools.
- `worktreePolicy: "off"` with write tools and no rollback note.
- Absolute prompt paths point outside the cwd where `/flow run` will be invoked.
- Review stages use write-capable agents/tools.
- A recipe redefines public recipes instead of referencing existing `flows/*.json`.
- The prompt says "safe local validation" but does not list commands or skipped commands.
