# A/B Execution Evaluation Plan

## Purpose

Evaluate whether one selected execution arm produces better user-facing results than another selected execution arm under the same task conditions, while separately measuring operational/system tradeoffs.

Initial scope is A vs B comparison. Each arm is an execution strategy selected by the user:

```text
A: selected execution arm
B: selected execution arm
```

An arm can be a flow recipe or a single agent delegation. The common recommended preset is "flow recipe vs single agent", but the skill should not hard-code that as the only comparison shape.

Do not expose any separate grouping concept in the first user-facing version.

The primary question is:

> Given the same task and context, which output is better when judged blindly?

The secondary question is:

> What system-level tradeoffs explain or qualify the output-quality result?

This distinction is important. Basic scoring must not reveal whether an output came from a flow, how many agents ran, how long it took, or how much internal structure/artifact support existed.

## Evaluation Modes

### Basic Evaluation: Blind Output Quality

The basic evaluation compares only final user-facing outputs.

Evaluator sees:

- task brief,
- Output A,
- Output B,
- rubric.

Evaluator must not see:

- which execution strategy produced A/B,
- token/cost usage,
- wall-clock latency,
- number of agents/tasks,
- flow stages,
- run IDs,
- board screenshots,
- logs,
- intermediate artifacts,
- failure/retry history.

Basic evaluation answers:

```text
Which result is better for the user?
```

### Advanced Evaluation: System/Operational Analysis

Advanced evaluation uses hidden metadata collected during execution.

It analyzes:

- token/cost,
- wall-clock latency,
- number of agents/tasks,
- artifact/process observability,
- recoverability,
- structural coverage,
- failure diagnostics,
- quality-per-cost,
- board UX usefulness.

Advanced evaluation answers:

```text
Was the better output worth the operational cost, and did the system behave more reliably?
```

Advanced metadata is recorded for every run, but it is only exposed after blind scoring is complete.

## User-Minimal Skill UX

The user should choose the comparison essentials, but the skill should keep that choice surface small and guided. The essential user-facing choices are:

```text
1. A: execution arm, either a flow recipe or an agent
2. B: execution arm, either a flow recipe or an agent
3. task: what both arms should do
4. optional model/reasoning setting shared by both arms
```

Do not ask the user to choose any higher-level category in the initial version. The skill is simply an A vs B comparison helper.

The user should not need to know judge schemas, metadata schemas, result directory layout, normalization mechanics, or validation details.

Default interaction:

```text
User: Compare two approaches for reviewing my current diff.

Skill:
Choose A:
- flow recipe from discovered recipes
- single agent from discovered agents

Choose B:
- flow recipe from discovered recipes
- single agent from discovered agents

Suggested preset for this task:
- A: flow recipe `review`
- B: agent `scout`

Model/reasoning:
- use current default for both arms
- or choose a specific model/reasoning setting for both arms
```

The skill should recommend defaults, but still let the user confirm or change them:

```text
Recommended A/B plan:
- Task: review current diff
- A: flow recipe `review`
- B: agent `scout`
- Model/reasoning: current default for both arms

Both arms will use the same model/reasoning setting. The judge will see only anonymized final outputs.
Run this comparison?
```

Ask follow-up questions only for these user-facing choices. Everything else should be handled internally by the skill and runner.

Recipe and agent choices must be discovered from the current user/project environment before prompting. Do not hardcode a fixed list except as examples in documentation. Model/reasoning choices should be read from the available Pi configuration when possible; otherwise offer "current default" plus a typed custom value.

## High-Level Protocol

For each task:

1. Infer a recommended A/B comparison plan from the user's goal.
2. Ask the user to confirm or choose A arm, B arm, task, and optional shared model/reasoning setting.
3. Show a short confirmation with only those choices and the blind-scoring guarantee.
4. Prepare the same initial state and task brief.
5. Run both arms according to their selected arm type.
6. Collect final outputs and internal metadata separately.
7. Build a blind package with randomized labels A/B.
8. Score outputs with a rubric.
9. Reveal mapping after scoring.
10. Combine blind scores with hidden metadata in an aggregate report.

## Comparison Arms

Both arms must use the same model family and reasoning/thinking setting unless the user explicitly chooses to test model/provider differences. The default target is execution strategy quality, not model quality. If model/reasoning is configurable in the current Pi environment, the skill may let the user choose it once and apply it to both arms.

Each arm has a type:

```text
recipe -> run a selected flow recipe
agent  -> run a selected single-agent delegation
```

### Recipe Arm

A recipe arm uses deterministic `/flow` recipes discovered from the current environment.

Examples:

```text
/flow recommend "<task>"
/flow run review
/flow run deep-review
/flow run deep-research
/flow run migration
```

The selected recipe must be recorded internally, but hidden from blind evaluators. The skill should use recipe catalog metadata and `/flow recommend` to propose recipe choices, but the user should confirm the recipe or choose an alternative before execution.

### Agent Arm

An agent arm uses a selected single-agent delegation path.

Examples:

```text
/flow delegate researcher "<task>"
/flow delegate scout "<task>"
```

The agent prompt should include the same user goal, constraints, and expected final format as the other arm when possible. It should not include hints about the other arm's internals, such as recipe stage names or hidden artifacts.

### Arm Selection Rules

The skill should discover both recipes and agents from the current environment, recommend a pair from the task category, and let the user confirm or change A and B.

Suggested defaults:

```text
code/repo mapping -> recipe: code-research or agent: scout
external research -> recipe: deep-research or agent: researcher
review -> recipe: review/deep-review or comparable review-capable agent
planning/migration -> recipe: migration or agent: planner
implementation -> recipe: implementation-slice or agent: implementer, only after confirmation
```

If a default is ambiguous, show the recommended arm with a short explanation and alternatives. The benchmark must avoid changing either arm after seeing results.

## Task Set Design

Start small. MVP should contain 3 task categories:

1. **Code map / research**
   - Goal: explain an unfamiliar code path or architecture area.
   - Expected flow advantage: evidence, coverage, artifact structure.
   - Expected single-agent advantage: speed and simplicity.

2. **Review with seeded or known issues**
   - Goal: review a diff or fixture containing known defects.
   - Expected flow advantage: completeness, finding verification, lower unsupported-claim rate.
   - Important: include a hidden answer key for objective correctness checks.

3. **Migration or implementation planning**
   - Goal: produce a staged plan for a bounded migration/change.
   - Expected flow advantage: decomposition, sequencing, risk coverage.

Advanced-only task categories can be added later:

- recovery from injected failures,
- continuation/approval loops,
- parallel fan-out stress tests,
- board UX usefulness studies,
- cost/latency optimization tasks.

## Skill-created Flow Recipes

If the interactive `flow-eval` skill needs to create a flow recipe for an eval arm, save it as a project-local recipe:

```text
.pi/flow-recipes/<name>.json
```

Reason: eval comparisons should be reproducible, inspectable, and re-runnable after the initial conversation. The recipe is part of the comparison contract, not a transient implementation detail.

Every skill-created recipe must be validated before use:

```text
/flow validate <recipe-name-or-path>
```

## Directory Layout

Planned implementation layout:

```text
evals/flow-vs-ad-hoc/
  README.md
  rubric.md
  tasks.json
  run.mjs
  judge-prompt.md
  fixtures/
  results/
    <timestamp>/
      manifest.json
      blind/
        <task-id>/
          task.md
          output-A.md
          output-B.md
          score-template.json
      internal/
        <task-id>/
          mapping.json
          arm-b/
            output.md
            metadata.json
            run.json
            artifacts/
          flow/
            output.md
            metadata.json
            run.json
            artifacts/
      scores/
        <task-id>.json
      report.md
```

## Task Definition Schema

Initial `tasks.json` shape:

```json
[
  {
    "id": "review-seeded-bug",
    "category": "review",
    "brief": "Review this diff for correctness, safety, and regressions.",
    "fixture": "fixtures/review-seeded-bug",
    "adHoc": {
      "agent": "scout",
      "prompt": "Review this diff for correctness, safety, and regressions. Provide evidence-backed findings only."
    },
    "flow": {
      "recipe": "review",
      "briefFile": "REVIEW_TARGET.md"
    },
    "answerKey": {
      "knownIssues": [
        "Missing validation allows invalid state transition"
      ]
    },
    "hardFailures": [
      "modifies files",
      "hallucinates file paths",
      "misses seeded critical issue",
      "fails to complete"
    ]
  }
]
```

## Blind Output Rubric

Each dimension is scored 1-5.

### Correctness

Does the output identify true facts/findings and avoid false claims?

- 1: mostly incorrect or misleading
- 3: mixed; useful but with notable errors
- 5: accurate, well-calibrated, no material false claims

### Completeness

Does the output cover the important aspects of the task?

- 1: misses most key points
- 3: covers some key points but misses important ones
- 5: covers the important dimensions with appropriate prioritization

### Evidence Quality

Are claims grounded in files, sources, quotes, commands, or reproducible evidence?

- 1: unsupported assertions
- 3: some evidence but uneven or vague
- 5: strong, specific, source-backed evidence

### Actionability

Can a user act on the output?

- 1: vague or not actionable
- 3: useful direction but needs interpretation
- 5: clear next steps, priorities, and tradeoffs

### Noise / Concision

Is the output appropriately concise and low-noise?

- 1: rambling, repetitive, or distracting
- 3: acceptable but could be tighter
- 5: concise without omitting important detail

### Calibration / Uncertainty

Does the output distinguish facts, inference, uncertainty, and caveats?

- 1: overconfident or uncalibrated
- 3: some caveats but inconsistent
- 5: clearly calibrated and honest about uncertainty

## Hard Failure Flags

Hard failures are recorded separately from 1-5 scores.

Examples:

```text
invalid-output
failed-to-complete
modified-files-in-read-only-task
hallucinated-file-path
unsupported-critical-claim
missed-known-critical-issue
unsafe-tool-use
```

A hard failure does not automatically decide every comparison, but it must be highlighted in the final report.

## Hidden Metadata Schema

Collected per run but hidden from blind evaluators:

```json
{
  "taskId": "review-seeded-bug",
  "arm": "flow",
  "runId": "flow_...",
  "status": "completed",
  "startedAt": "2026-06-03T00:00:00.000Z",
  "completedAt": "2026-06-03T00:02:03.000Z",
  "durationMs": 123000,
  "taskCount": 5,
  "agentCount": 2,
  "failedTaskCount": 0,
  "retryCount": 0,
  "continuationUsed": false,
  "artifactCount": 12,
  "outputBytes": 8421,
  "estimatedTokens": null,
  "estimatedCostUsd": null,
  "boardObservable": true,
  "recoverabilityNotes": "stage-level task logs and JSON outputs available",
  "failureDiagnostics": []
}
```

Token/cost can be null in MVP if no reliable source exists. The harness should still collect task count, duration, status, and artifact counts.

## Blind Package Generation

For each task, randomize the arm labels:

```text
output-A.md
output-B.md
```

Store the mapping internally:

```json
{
  "taskId": "review-seeded-bug",
  "A": "flow",
  "B": "agent:scout"
}
```

The mapping must not be included in files given to evaluators.

### Blind Output Normalization

This is mandatory. Before scoring, each arm must be normalized into a comparable final-output-only document.

Include:

- task-relevant final answer,
- evidence/citations/file references that were part of the final answer,
- recommended actions and caveats.

Exclude:

- run IDs,
- mode labels such as recipe/agent or concrete arm names,
- stage names,
- task counts,
- token/cost/latency metadata,
- logs,
- board screenshots,
- intermediate artifacts,
- artifact paths that reveal orchestration mode unless they are essential evidence.

The extraction rule should be deterministic and recorded in the result manifest. The benchmark should not manually polish one arm more than the other.

## Scoring

### MVP: LLM Judge Scoring

The MVP uses LLM-based blind scoring from the start. This is part of the purpose of the eval harness: to repeatedly compare outputs with a consistent rubric and judge configuration.

The judge receives only:

- task brief,
- normalized Output A,
- normalized Output B,
- rubric,
- required JSON score schema.

The judge must not receive hidden operational metadata or A/B mapping.

Example score output:

```json
{
  "taskId": "review-seeded-bug",
  "scores": {
    "A": {
      "correctness": 4,
      "completeness": 5,
      "evidenceQuality": 4,
      "actionability": 4,
      "noiseConcision": 3,
      "calibration": 4,
      "hardFailures": [],
      "notes": "Strong evidence but verbose."
    },
    "B": {
      "correctness": 3,
      "completeness": 3,
      "evidenceQuality": 2,
      "actionability": 4,
      "noiseConcision": 5,
      "calibration": 3,
      "hardFailures": ["missed-known-critical-issue"],
      "notes": "Concise but missed important issue."
    }
  },
  "winner": "A",
  "winnerRationale": "A has stronger evidence and catches the key issue."
}
```

### Judge Bias Controls

Because LLM judges can be order-biased and inconsistent, the MVP should include basic mitigations:

- randomize A/B order,
- optionally run reversed-order scoring for the same pair,
- use a fixed judge model and fixed reasoning/thinking setting for a run,
- keep per-dimension scores independent,
- require structured JSON output,
- keep manual/human review as spot-check or calibration, not as the default scoring path.

## Aggregate Report

The final report should have two distinct sections.

### 1. Blind Output Quality Results

Only rubric scores and hard failures.

Example:

```text
Flow won 2/3 tasks on blind output quality.
Arm B won 1/3 tasks on concision and speed-sensitive simple lookup.
Arm A average evidence score: 4.6
Arm B average evidence score: 3.1
```

### 2. System/Operational Analysis

Metadata after mapping reveal.

Example:

```text
Flow was 2.3x slower and used 3.4x more task executions.
Flow produced more artifacts and had better failure diagnostics.
Arm B had better quality-per-minute on simple lookup.
Flow had better quality-per-run on review and migration planning.
```

## Fairness Controls

- Use the same task brief for both arms.
- Use the same repo/fixture state.
- Reset fixture state before each arm.
- Randomize run order where possible.
- Hide mode metadata from evaluators.
- Avoid intentionally weak prompts for either arm.
- Record model and agent configuration internally.
- Keep answer keys hidden from evaluators unless used only for objective post-checks.

## MVP Implementation Steps

1. Create `evals/ab-execution/rubric.md`.
2. Create `evals/ab-execution/tasks.json` with 3 tasks.
3. Require each task to specify both A and B arms explicitly.
4. If the flow arm requires a new recipe, save it to `.pi/flow-recipes/<name>.json`.
5. Validate any skill-created recipe before use.
6. Implement `run.mjs` to execute both arms with the same model/reasoning setting and collect outputs/metadata.
7. Normalize each final output into blind `output-A.md` / `output-B.md` packages.
8. Run LLM judge scoring with a fixed judge model/reasoning setting and structured JSON schema.
9. Generate aggregate `report.md` with blind scores first, then hidden operational analysis.
10. Add manual/human spot-checks only as calibration once the automated loop works.

## Non-goals for MVP

- Human-first scoring workflow.
- Precise provider billing integration.
- Perfect token accounting.
- Large benchmark coverage.
- Board UX user study.
- Recovery/failure injection.

These belong in advanced evaluation once the basic blind-output comparison is stable.
