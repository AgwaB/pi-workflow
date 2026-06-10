# pi-workflow

**Workflow orchestration for Pi subagents.**

`pi-workflow` turns multi-subagent work into explicit workflows that Pi can run, inspect, and adapt.

Start with built-in workflows for verified research and evidence-backed review. Other workflow shapes are deferred until stronger task-fit evidence exists.

## Try this first

After installation, ask Pi naturally:

```text
Deep research this repo and summarize the architecture tradeoffs.
```

```text
Review the current diff from multiple angles.
```

```text
Deep review this change and challenge any findings before the final report.
```

## Installation

```bash
pi install npm:pi-workflow
```

## How workflows work

A workflow is a sequence of stages. Users can ask for workflows in natural language; each workflow is backed by a definition file that describes the stage graph.

Stage order controls scheduling, but a plain later `task` does **not** automatically receive prior outputs. Workflow definitions must explicitly pass prior results through `foreach.from` or `reduce.from`.

![Workflow stage types](./docs/assets/readme-stage-types.png)

| Stage | Use it for | Runtime shape |
|---|---|---|
| `task` | One focused step | one prompt -> one subagent |
| `parallel` | Static fan-out | fixed task list -> multiple subagents, bounded concurrency |
| `foreach` | Dynamic fan-out | read an array from prior JSON output -> one subagent task per item |
| `reduce` | Fan-in / synthesis | selected prior stage context -> one subagent |
| `transform` | Deterministic local post-processing | selected prior structured outputs -> directory-local `.mjs` helper -> structured output |
| `loop` | Bounded repetition | repeat a fixed child stage subgraph each round until a deterministic stop condition |

`reduce` is not an automatic merge function. In the diagrams, **Supervisor** means the workflow runtime that gathers prior subagent outputs and passes bounded source context into a reduce subagent. It is not a user-defined agent.

A minimal workflow definition looks like:

```json
{
  "schemaVersion": 1,
  "agent": "researcher",
  "readOnly": true,
  "tools": ["read", "grep", "find", "ls", "web_search", "fetch_content"],
  "workflow": {
    "stages": [
      {
        "id": "plan",
        "type": "task",
        "output": {
          "format": "json",
          "contract": { "requiredPaths": ["$.questions"] }
        },
        "prompt": "Plan the research questions."
      },
      {
        "id": "research",
        "type": "foreach",
        "from": { "stage": "plan", "path": "$.questions", "mode": "concat" },
        "maxConcurrency": 4,
        "each": { "prompt": "Research this question: ${item}" }
      },
      {
        "id": "summary",
        "type": "reduce",
        "from": ["plan", "research"],
        "prompt": "Use Source Stage Context to synthesize the answer."
      }
    ]
  }
}
```

## Built-in workflows

The package includes built-in workflow definitions in [`workflows/`](./workflows/). The concrete task is supplied at runtime. When the parent agent needs a deterministic starting point, `/workflow recommend "<request>"` scores workflow metadata and returns an explicit workflow name to validate/run.

| Workflow | Shape | Use when |
|---|---|---|
| `deep-research` | task -> foreach -> reduce -> foreach -> transform -> reduce | Source-backed research, claim verification, deterministic evidence gating, citations, or follow-up suggestions. |
| `deep-review` | task -> foreach -> foreach -> reduce | Panel-style review where findings should be challenged before final synthesis. |
| `implement-loop` | loop: implement -> final check | Iterative implementation in one managed worktree until validation passes and review accepts. |
| `test-repair-loop` | loop: repair -> final test-check | Focused repair loop for failing tests or explicit validation commands. |

Other workflow shapes such as migration planning, implementation batches, best-of-N fixes, revise loops, and decision debates are intentionally deferred until stronger task-fit evidence exists.

### `deep-research` at a glance

![Deep research workflow](./docs/assets/readme-deep-research.png)

```json
{
  "name": "deep-research",
  "workflow": {
    "stages": [
      { "id": "plan", "type": "task" },
      {
        "id": "research-questions",
        "type": "foreach",
        "from": { "stage": "plan", "path": "$.researchQuestions" }
      },
      {
        "id": "normalize-claims",
        "type": "reduce",
        "from": ["plan", "research-questions"]
      },
      {
        "id": "verify-claims",
        "type": "foreach",
        "from": { "stage": "normalize-claims", "path": "$.claimsForVerification" }
      },
      {
        "id": "audit-claims",
        "type": "transform",
        "from": "verify-claims",
        "helper": "./helpers/claim-evidence-gate.mjs"
      },
      {
        "id": "final",
        "type": "reduce",
        "from": ["plan", "research-questions", "normalize-claims", "audit-claims"]
      }
    ]
  }
}
```

The snippet above is intentionally abbreviated. Runnable workflow definitions also declare prompts, output contracts, source policies, tools, and runtime limits.

JSON outputs are validated with `output.contract` (for example `requiredPaths`, array bounds, and string length caps). To give models a shape hint without duplicating validation rules inline, use `output.template` for small one-off shapes or `output.templateRef` for reusable templates. `templateRef` supports internal refs such as `#/outputTemplates/final` and relative JSON files such as `./templates.json#/final` inside workflow bundles.

## Create or customize workflows with `workflow-guide`

`pi-workflow` includes a `workflow-guide` skill for creating custom workflow definitions.

Use it when you want to adapt a built-in workflow or create a project-specific workflow. The guide starts from existing workflows when possible, applies the stage-first rules, checks `foreach.from` / `reduce.from` data dependencies, handles tool ceilings and worktree policy, and validates the workflow definition before handoff.

Project workflow definitions should be saved under:

```text
.pi/workflows/<name>.json
```

Examples:

```text
Use workflow-guide to create a workflow for weekly release readiness.
It should inspect the repo, check docs/tests risk, and produce a final checklist.
```

```text
Use workflow-guide to customize deep-review for frontend accessibility and UX review.
Save it as .pi/workflows/frontend-review.json.
```

```text
Use workflow-guide to review this workflow definition and fix any invalid stage dependencies:
.pi/workflows/my-workflow.json
```

```text
Use workflow-guide to create a bounded implementation workflow for this repo.
Ask before dependency installs, long validation, or broad edits.
```

Then validate and run:

```text
/workflow validate .pi/workflows/frontend-review.json
/workflow run frontend-review "Review the current diff for accessibility and UX regressions."
```

The most important authoring rule: stage order only controls scheduling. It does not automatically pass prior output into later `task` stages. Use `foreach.from` for dynamic fan-out and `reduce.from` for source-context fan-in.

## `loop` stages

A `loop` stage repeats a **fixed** child stage subgraph once per round until a deterministic stop condition holds, or until `maxRounds`/no-progress stops it. It is intra-run only: a loop does not start a new workflow run, and it does not choose different stages per round (that is out of scope for v1).

```json
{
  "id": "fix-loop",
  "type": "loop",
  "maxRounds": 5,
  "until": {
    "all": [
      { "stage": "check", "path": "$.status", "equals": "pass" },
      { "stage": "check", "path": "$.verdict", "equals": "ACCEPT" }
    ]
  },
  "stages": [
    { "id": "implement", "type": "task", "agent": "delegate", "readOnly": false, "tools": ["read", "grep", "find", "ls", "edit", "write"], "prompt": "Fix the current round's blocking failures." },
    { "id": "check", "type": "task", "agent": "scout", "tools": ["read", "grep", "find", "ls", "bash"], "output": { "format": "json", "requiredKeys": ["status", "verdict"] }, "prompt": "Run the approved validation and review the change. Return JSON with status, verdict, blockingFailures, nextHints." }
  ],
  "onExhausted": {
    "id": "loop-summary",
    "type": "reduce",
    "prompt": "Summarize remaining failures and recommended human next action. Do not auto-merge."
  }
}
```

Rules and behavior:

- **Ids**: the loop and every child stage require non-empty ids; child ids must be unique. Child stages are materialized at runtime with deterministic ids `<loopId>.r01.<childStageId>`, `<loopId>.r02.<childStageId>`, and so on. Round R fully precedes round R+1.
- **`maxRounds`** is required, a positive integer, capped at 50.
- **`until`** is required and deterministic (no model judgment). Leaf form is `{ stage, path, equals | notEquals | lengthEquals }`; combinators are `{ all: [...] }` and `{ any: [...] }`. `path` must start with `$.` and is read from that child stage's latest-round JSON output. `stage` must reference a child stage id. A missing path evaluates to false.
- **No-progress stop**: the loop stops early (`stopped_no_progress`) when the progress metric does not strictly decrease versus the previous round. The default metric is the length of `$.blockingFailures` on the designated check stage; override with `progressPath`. If `progressPath` resolves to an unsupported value such as a boolean/object/null, the check task records a warning and the comparison is skipped for that round.
- **`onExhausted`** is optional and must be a `reduce` stage. It runs once when the loop exhausts `maxRounds` or stops on no-progress.
- **Separation rule**: loops require at least two child stages, child stages run strictly in listed order (`from` is rejected inside loops), and every `until` leaf must reference the final child stage. Keep the final validator/reviewer read-only in practice; validation commands such as `bash` are allowed for checks, but the check prompt must not modify files. The engine never merges implement and check; merging reintroduces self-preferential bias.
- **Worktree**: write-capable child stages share a single managed worktree reused across rounds. There is no auto-merge. On completion the loop records a result (`status`, `roundsUsed`, `worktreePath`, `finalCheck`, `summary`) for a human to merge.
- Nested `loop`, `foreach`, and `parallel` child stages are rejected in v1.

## Commands

User-facing command surface:

```text
/workflow                # open the workflow board
/workflow <run-id>       # open the board focused on a run
/workflow help
```

For read-only terminal inspection of an existing run, use the CLI instead of launching a workflow:

```bash
pi-workflow inspect workflow_mq224pi8_775e71
pi-workflow inspect workflow_mq224pi8_775e71 --failures
pi-workflow inspect workflow_mq224pi8_775e71 --results
pi-workflow inspect workflow_mq224pi8_775e71 --json
```

<details>
<summary>Agent-facing/internal commands</summary>

These commands remain available for orchestration, workflow authoring, and debugging:

```text
/workflow validate <workflow-name-or-path>
/workflow roles
/workflow agents
/workflow recommend "<request>"
/workflow list
/workflow show <workflow-name>
/workflow run <workflow-name-or-path> "<task>"
/workflow delegate ...
/workflow status
/workflow show <run-id>
/workflow view [run-id]
/workflow logs <run-id> [task-id] [lines]
/workflow continue <run-id>
/workflow wait <run-id> [timeout-ms]
```

</details>

## Safety notes

- `/workflow` is an orchestrator, not an OS sandbox.
- Agent-declared tools are the authority ceiling; workflow definitions can only narrow them.
- `readOnly: true` is enforced through tool filtering, not filesystem isolation.
- Review workflows should remain read-only unless a workflow explicitly documents managed-worktree mutation.
- Mutation-capable tasks should normally use managed worktrees in git repositories.
- In non-git workspaces, write-capable workflows with `worktreePolicy: "off"` mutate the live directory.
- No backend fallback exists: the resolved backend/strategy is fixed per run.

## Detailed docs

- [`docs/workflow-authoring.md`](./docs/workflow-authoring.md) — how to create/review stage-first workflow definitions; use this as the main authoring guide.
- [`docs/usage-reference.md`](./docs/usage-reference.md) — detailed command, schema, runtime, output, role, worktree, and safety reference.
- [`docs/ab-execution-test-strategy.md`](./docs/ab-execution-test-strategy.md) — local A/B validation method and prepared test inventory.
- [`docs/ab-execution-results.md`](./docs/ab-execution-results.md) — corrected workflow-vs-baseline A/B evaluation summary.
- [`workflows/README.md`](./workflows/README.md) — bundled workflow notes.
- [`docs/readme-image-plan.md`](./docs/readme-image-plan.md) — README diagram slots and copy guidance.
