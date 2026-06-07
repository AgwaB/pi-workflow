# Deep Research Workflow Ideas

Working notes for possible `/flow` deep-research and dynamic workflow designs. These are exploratory ideas, not committed implementation plans.

## Current v2 proposal summary

Goal: make `/flow` a clean, stage-first subagent delegation format. `/flow` should orchestrate subagents, artifacts, context handoffs, dynamic item fan-out, and bounded continuation. It should not become a domain-specific QA/review/migration framework, and it should not require v1 backward compatibility.

### Core boundary

- `/flow` models **delegation structure**, not every domain action.
- Domain work remains inside subagent prompts and recipe conventions.
- `/flow` owns engine/stage/continuation status; task outputs own domain status.
- The supervisor is deterministic runtime code, not an LLM agent.
- Child subagents do not launch later stages; the `/flow` supervisor schedules stages and injects context.

### v2 shape

Use stage-first syntax:

```json
{
  "schemaVersion": 2,
  "name": "example-flow",
  "readOnly": true,
  "tools": ["read", "grep", "find", "ls"],
  "input": {},
  "flow": {
    "stages": []
  }
}
```

Top-level `flow.type` is removed. `flow.stages` means the workflow is a sequential stage composition. Dynamic continuation is declared on the stage that may produce a `nextFlowSpec`, not as a top-level `flow.continuation` block.

### Initial v2 stage types

- `task`: one subagent task.
- `parallel`: explicit fan-out over listed tasks.
- `reduce`: one downstream subagent task that consumes previous stage context.
- `foreach`: bounded dynamic item fan-out from a previous structured output array.

Deferred / not initial v2:

- `dag` stage support: roadmap only.
- `chain` stage: unnecessary because `flow.stages` is already sequential.
- `map`, `partition`, `route`: not initial v2 concepts; `foreach` covers the needed dynamic expansion shape.
- `purpose`: optional metadata at most; behavior is defined by `prompt`.

### Inheritance

Common execution fields inherit in this order:

```text
each/task item > stage > top-level > agent definition default
```

Inheritable fields:

- `agent`
- `readOnly`
- `tools`
- `model`
- `thinking`
- `timeout`
- `worktreePolicy`
- `output`

Local-only fields:

- `id`
- `type`
- `from`
- `prompt`
- `maxItems`
- `maxConcurrency`
- `sourcePolicy`
- `continuation`

### Tools and safety

- v2 may let flow/stage/task `tools` set the effective tool set instead of treating agent tools as an unbreakable ceiling.
- Effective tools must be visible in validation/preview.
- Every effective tool must be defined either by `/flow`'s built-in tool registry or by spec-local `toolDefinitions`.
- Delegation/orchestration tools remain invalid for child agents.
- Unknown custom tools with no definition fail closed.
- `readOnly: true` conflicts with explicit write tools (`edit`, `write`).
- `bash` is mutation-capable for safety classification; it may trigger worktree/approval/isolation behavior rather than being treated as safe shared-checkout read-only.
- Read-only fan-out normally uses the shared checkout; mutation-capable fan-out should use managed worktrees.

Initial custom tool definition shape:

```json
{
  "toolDefinitions": {
    "company_docs_search": { "capability": "read-only" },
    "jira_create_ticket": { "capability": "external-mutation" },
    "deploy_prod": { "capability": "forbidden" }
  }
}
```

Initial capability enum:

- `read-only`
- `write-capable`
- `mutation-capable`
- `external-mutation`
- `forbidden`

Keep this schema small initially; network/domain/secrets/cost policy can be added later if real workflows need it.

### Stage context handoff

When a stage consumes earlier stages, `/flow` compiles a bounded context section into the downstream subagent prompt. The main chat agent does not manually shuttle results between stages.

Context includes compact metadata and artifact references:

```text
# Source Stage: reviewers

## Task backend-review
status: completed
agent: backend-expert
output: .pi/flows/<run>/stages/reviewers/tasks/backend-review/output.log
result: .pi/flows/<run>/stages/reviewers/tasks/backend-review/result.json
output preview:
...
```

Structured output previews are included when available; full logs remain artifact paths.

### `from` rules

- Forward references are invalid. A stage may only consume already-declared previous stages.
- `reduce` cannot be the first stage.
- `reduce.from` may be omitted; if omitted, it consumes the immediately previous stage.
- `reduce.from` may be a string stage id or an array of previous stage ids.
- `foreach.from` is required and uses object form:

```json
{ "stage": "extract-claims", "path": "$.claims" }
```

### Source issue policy

`reduce` uses `sourcePolicy`:

- `require-success` (default): all consumed source tasks/stages must complete successfully.
- `partial`: run with available outputs and include failed/blocked/skipped source statuses in context.

Domain failures inside completed task output do not affect engine scheduling; the reduce task interprets them as data.

### `foreach`

`foreach` is required in initial v2.

```json
{
  "id": "verify-claims",
  "type": "foreach",
  "from": { "stage": "extract-claims", "path": "$.claims" },
  "maxItems": 20,
  "maxConcurrency": 5,
  "each": {
    "agent": "scout",
    "prompt": "Verify this claim: ${item}"
  }
}
```

Rules:

- Reads an array from a prior structured stage output.
- `maxItems` is required.
- If the array exceeds `maxItems`, expansion fails/blocks; no silent truncation and no overflow modes.
- Upstream extractor/planner prompts should be told the downstream limit.
- One `each` template only in initial v2.
- Item context is injected into each child prompt.
- If item object has a string `id`, use it for generated task id after sanitization; otherwise use `item-001` style stable index.
- Duplicate generated ids fail closed.

### Structured output

Structured output is optional and should be used only when the supervisor or a later stage needs machine-readable data.

Use structured output for:

- `foreach.from` source arrays.
- continuation decisions / `nextFlowSpec` detection.
- verifier results that final synthesis consumes mechanically.

Do not force structured output for ordinary human-readable review/research stages.

### Continuation

Dynamic continuation is stage-local. A stage with a `continuation` block is explicitly dynamic, and `/flow` checks only that stage's structured output for a top-level `nextFlowSpec`.

```json
{
  "id": "final-or-continue",
  "type": "reduce",
  "continuation": {
    "mode": "auto|ask|on-risk",
    "maxRounds": 3,
    "maxGeneratedTasks": 12,
    "maxTasksPerRound": 5,
    "allowedAgents": ["scout"],
    "allowedTools": ["read", "grep", "find", "ls"],
    "onInvalidGeneratedSpec": "block"
  },
  "output": { "format": "json", "requiredKeys": ["summary"], "onInvalid": "fail" },
  "prompt": "Write finalReport if enough evidence exists. If more work is needed, include top-level nextFlowSpec."
}
```

Rules:

- If no stage has `continuation`, the flow has no generated child flow continuation.
- Initial v2 allows at most one continuation stage per flow.
- `continuation` is local-only and not inherited.
- `mode: "auto"`: validate and launch generated child flows automatically within bounds.
- `mode: "ask"`: pause for workflow-direction decision after a proposed next flow; user does not manually craft another `/flow run` command.
- `mode: "on-risk"`: continue automatically unless uncertainty, fan-out, budget, mutation capability, or policy warnings require a workflow-direction decision.

Generated child flows:

- Are produced by a top-level `nextFlowSpec` in the continuation stage's structured output.
- Are saved as artifacts.
- Are validated before launch.
- Run as linked child runs.
- Do not mutate the active graph in-place.
- Cannot exceed parent continuation bounds.
- Count rounds/tasks across the full lineage.

### Loop guards

Required guards:

- `maxRounds` across parent/child lineage.
- `maxGeneratedTasks` across lineage.
- `maxTasksPerRound` per generated child spec.
- Child continuation cannot exceed the originating stage continuation ceiling.
- Repeated generated spec hashes block.
- Stage ids unique.
- `from` only references previous stages.
- `foreach.maxItems` required and overflow fails.

### Dirty worktree snapshot

When a mutation-capable task needs a managed worktree and the source checkout has uncommitted changes, v2 should prefer Codex-like current-state worktrees.

Initial policy:

- Create the managed worktree from current `HEAD`.
- Capture tracked modified/deleted/staged files as a patch and apply it to the managed worktree.
- Copy untracked non-ignored files.
- Do not copy ignored files by default.
- Save snapshot metadata/artifacts.
- If snapshot capture or apply fails, fail/block; do not silently run against clean `HEAD`.

This keeps user-visible behavior aligned with "run against my current working state" while avoiding full directory copies of `.git`, dependencies, generated artifacts, ignored files, and secrets.

### Dirty worktree snapshot

When a mutation-capable task needs a managed worktree and the source checkout has uncommitted changes, v2 should prefer Codex-like current-state worktrees.

Initial policy:

- Create the managed worktree from current `HEAD`.
- Capture tracked modified/deleted/staged files as a patch and apply it to the managed worktree.
- Copy untracked non-ignored files.
- Do not copy ignored files by default.
- Save snapshot metadata/artifacts.
- If snapshot capture or apply fails, fail/block; do not silently run against clean `HEAD`.

This keeps user-visible behavior aligned with "run against my current working state" while avoiding full directory copies of `.git`, dependencies, generated artifacts, ignored files, and secrets.

### Dirty worktree snapshot

When a mutation-capable task needs a managed worktree and the source checkout has uncommitted changes, v2 should prefer Codex-like current-state worktrees.

Initial policy:

- Create the managed worktree from current `HEAD`.
- Capture tracked modified/deleted/staged files as a patch and apply it to the managed worktree.
- Copy untracked non-ignored files.
- Do not copy ignored files by default.
- Save snapshot metadata/artifacts.
- If snapshot capture or apply fails, fail/block; do not silently run against clean `HEAD`.

This keeps user-visible behavior aligned with "run against my current working state" while avoiding full directory copies of `.git`, dependencies, generated artifacts, ignored files, and secrets.

### Dirty worktree snapshot

When a mutation-capable task needs a managed worktree and the source checkout has uncommitted changes, v2 should prefer Codex-like current-state worktrees.

Initial policy:

- Create the managed worktree from current `HEAD`.
- Capture tracked modified/deleted/staged files as a patch and apply it to the managed worktree.
- Copy untracked non-ignored files.
- Do not copy ignored files by default.
- Save snapshot metadata/artifacts.
- If snapshot capture or apply fails, fail/block; do not silently run against clean `HEAD`.

This keeps user-visible behavior aligned with "run against my current working state" while avoiding full directory copies of `.git`, dependencies, generated artifacts, ignored files, and secrets.

### Artifact layout

Use stage-oriented artifacts:

```text
.pi/flows/<run-id>/
  spec.json
  compiled.json
  run.json
  stages/
    <stage-id>/
      stage.json
      tasks/
        <task-id-or-main>/
          prompt.md
          output.log
          stderr.log
          result.json
  generated/
    manifest.json
    <generated-spec-id>.json
```

Task directory naming:

- `task` stage: `tasks/main/`.
- `reduce` stage: `tasks/main/`.
- `parallel`: explicit task ids.
- `foreach`: sanitized item id or `item-001`.

### ID rules

- Stage ids are required and unique across the flow.
- Explicit task ids in a stage are required and unique within that stage.
- Runtime/global task key uses `stageId.taskId`, e.g. `reviewers.backend-review`.
- Generated ids are sanitized and collision-checked.

### Status semantics

Keep these separate:

- Engine task status: `pending`, `running`, `completed`, `failed`, `blocked`, `skipped`, `timeout`.
- Stage status: aggregate of child task states; may include `partial` when configured.
- Domain status: recipe/task output, e.g. claim supported, finding refuted, tests failed.
- Continuation status: `final`, `continued`, `blocked`, `max-rounds-reached`, `invalid-generated-spec`, `repeated-generated-spec`.

### Minimal auto-review example

```json
{
  "schemaVersion": 2,
  "name": "auto-review",
  "readOnly": true,
  "tools": ["read", "grep", "find", "ls"],
  "input": {
    "targetFile": "REVIEW_TARGET.md"
  },
  "flow": {
    "stages": [
      {
        "id": "reviewers",
        "type": "parallel",
        "tasks": [
          {
            "id": "backend-review",
            "agent": "backend-expert",
            "prompt": "Review ${input.targetFile} for backend/runtime/concurrency risks. Return findings with evidence."
          },
          {
            "id": "frontend-review",
            "agent": "frontend-expert",
            "prompt": "Review ${input.targetFile} for frontend/UX/a11y risks. Return findings with evidence."
          },
          {
            "id": "general-review",
            "agent": "scout",
            "prompt": "Review ${input.targetFile} for product/API/documentation consistency risks. Return findings with evidence."
          }
        ]
      },
      {
        "id": "extract-and-dedupe",
        "type": "reduce",
        "agent": "scout",
        "prompt": "Read reviewer outputs. Extract concrete findings, merge duplicates, preserve evidence, and separate uncertain claims. Return a concise triage report."
      }
    ]
  }
}
```

### Deep research example sketch

```json
{
  "schemaVersion": 2,
  "name": "deep-research",
  "readOnly": true,
  "tools": ["read", "grep", "find", "ls", "web_search", "fetch_content"],
  "input": {
    "briefFile": "DEEP_RESEARCH_BRIEF.md"
  },
  "flow": {
    "stages": [
      {
        "id": "researchers",
        "type": "parallel",
        "tasks": [
          { "id": "source-landscape", "agent": "scout", "prompt": "Read ${input.briefFile}. Research the source landscape. Prefer primary sources and cite URLs." },
          { "id": "technical-details", "agent": "scout", "prompt": "Read ${input.briefFile}. Research implementation/API details. Prefer official docs and cite URLs." },
          { "id": "risks-limitations", "agent": "scout", "prompt": "Read ${input.briefFile}. Research limitations, criticisms, costs, and failure modes. Cite sources." }
        ]
      },
      {
        "id": "extract-claims",
        "type": "reduce",
        "agent": "scout",
        "output": { "format": "json", "requiredKeys": ["claims", "omitted"], "onInvalid": "fail" },
        "prompt": "Extract at most 20 claims that need verification. Prioritize central, high-impact, or uncertain claims. Return JSON with claims and omitted."
      },
      {
        "id": "verify-claims",
        "type": "foreach",
        "from": { "stage": "extract-claims", "path": "$.claims" },
        "maxItems": 20,
        "maxConcurrency": 5,
        "each": {
          "agent": "scout",
          "output": { "format": "json", "requiredKeys": ["claimId", "status", "evidence", "rationale"], "onInvalid": "fail" },
          "prompt": "Verify this claim against cited sources and independent evidence: ${item}. Use status supported, disputed, unsupported, or needs-human."
        }
      },
      {
        "id": "final-or-continue",
        "type": "reduce",
        "from": ["researchers", "extract-claims", "verify-claims"],
        "sourcePolicy": "partial",
        "agent": "scout",
        "continuation": {
          "mode": "auto",
          "maxRounds": 3,
          "maxGeneratedTasks": 12,
          "maxTasksPerRound": 5,
          "allowedAgents": ["scout"],
          "allowedTools": ["read", "grep", "find", "ls", "web_search", "fetch_content"],
          "onInvalidGeneratedSpec": "block"
        },
        "output": { "format": "json", "requiredKeys": ["summary"], "onInvalid": "fail" },
        "prompt": "Use verified claims to write the final cited report. If concrete gaps remain, include a top-level nextFlowSpec for one targeted additional round within the continuation policy."
      }
    ]
  }
}
```

## Earlier notes

The rest of this file preserves the discussion log, alternatives, and pressure-test notes that led to the current proposal.

## Idea 1: Lead-agent-generated next flow

Let a lead agent inspect the current research state and emit the **next flow spec** to run.

Concept:

```text
current flow result
  ↓
lead agent evaluates gaps / contradictions / confidence
  ↓
lead agent writes next flow JSON
  ↓
/flow validates the generated spec
  ↓
human or policy approves run
  ↓
next flow executes
```

Example decisions the lead agent may make:

- If independent angles remain, generate a `parallel` flow.
- If evidence must be checked in order, generate a `chain` or `dag` flow.
- If a fixed file/source list exists, generate a `map` or `partition` flow.
- If output quality failed, generate a bounded `retry` or `until-pass` flow.
- If confidence is sufficient, generate a final `synthesize`/report flow.

Guardrails:

- Generated flow is data, not automatically trusted code.
- `/flow validate` must pass before execution.
- Exact tool/agent/worktree limits still apply.
- Budget and fan-out limits must be explicit.
- No hidden auto-run unless the user has explicitly approved that bounded target.
- Preserve all generated specs and parent/child run links as artifacts.
