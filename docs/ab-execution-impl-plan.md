# A/B Execution Eval — Implementation Plan

Short implementation plan for the runner described in [`ab-execution-eval-plan.md`](./ab-execution-eval-plan.md). Design lives there; this file is only the build plan.

## Scope (MVP)

All eval files live under `.pi/eval/ab-execution/` and are local-only (gitignored via `.pi/*`).

- One CLI runner: `.pi/eval/ab-execution/run.mjs`.
- One task file: `.pi/eval/ab-execution/tasks.json`.
- One rubric: `.pi/eval/ab-execution/rubric.md`.
- One judge prompt: `.pi/eval/ab-execution/judge-prompt.md`.
- Output under `.pi/eval/ab-execution/runs/<timestamp>/`.

Out of scope for MVP: interactive skill UX, multi-suite concept, token/cost billing, and fixture state reset automation.

## Runtime facts (verified)

- Pi runs non-interactively as: `pi --offline --no-session ... -e <pkg> -p "/workflow run <ref> <task>"` for schemaVersion 2 workflows (see `e2e-test/run.mjs`).
- `/workflow run <workflow-or-file> <task>` prints a workflow run id (`workflow_...`).
- `/workflow wait <run-id> [timeout-ms]` blocks until terminal.
- Per-run state: `.pi/workflows/<run-id>/run.json` with `status`, `taskSummary`, `tasks[]`.
- Each task has `files.output` (output.log), `files.result` (result.json), `stageId`, `kind`, `elapsedMs`, `startedAt`, `completedAt`, `output` contract.
- Specs accept `model` and `thinking` at top-level/stage/task. `thinking` is an enum (THINKING_LEVELS).

## Task schema (tasks.json)

```json
[
  {
    "id": "research-agent-evals",
    "task": "Research best practices for evaluating coding-agent workflows.",
    "arms": {
      "A": { "type": "workflow", "name": "deep-research" },
      "B": { "type": "plain" },
      "C": { "type": "parallel5", "agent": "researcher" }
    },
    "model": null,
    "thinking": null,
    "evaluationHypothesis": {
      "expectedAdvantage": "workflow",
      "taskClass": "coverage-diverse-research",
      "drivers": ["high-breadth", "parallelizable-branches"],
      "riskFactors": ["coordination-overhead"],
      "reason": "Broad research should reward independent source discovery and context-isolated evidence gathering."
    }
  }
]
```

- `arms` may contain two or more labeled arms (`A`, `B`, optional `C`, ...).
- Supported arm types are `workflow`, `agent`, `plain`, and `parallel5`.
- `plain` is a direct single Pi call with no expert agent/persona wrapper.
- `parallel5` is a simple five-way research fanout plus synthesis, intended only as a research comparison point.
- `model`/`thinking` are shared by all arms; `null` means use environment default. Runner-level `--model` / `--thinking` may override all arms for a run.
- All arms get the same `task` text.
- Optional `fixture` points to local evidence such as a patch file.
- Optional `answerKey` is hidden metadata for seeded tasks; it is not passed to arms or judges.
- Optional `coverageCriteria` documents human spot-check expectations for open-ended research tasks.
- Optional `evaluationHypothesis` records expected task-fit (`workflow`, `plain`, `tie`, or `uncertain`), task class, drivers, risks, and rationale. It is validated and reported but does not affect execution, judge scoring, or winner derivation.

## Arm execution

For each arm:

- `workflow`: `/workflow run <name> <task>`.
- `agent`: `/workflow delegate <name> "<task>"`.

Shared model/reasoning:

- Model/reasoning defaults to the user's current setting. If overridden, run a generated workflow file so the override applies to both arms equally. Save generated files under `.pi/eval/ab-execution/.generated/`, then `/workflow run <workflow-path> <task>`.
- If no override, call the workflow/delegate path directly.

Then `/workflow wait <run-id>` and read `.pi/workflows/<run-id>/run.json`.

## Final-output extraction (deterministic)

Rule for picking the arm's final user-facing output from `run.json.tasks`:

1. Consider only `status === "completed"` tasks.
2. Prefer the last task (by array order) whose `kind` is a synthesis kind: `reduce` | `aggregate` | `synthesize` | `judge` | `vote`.
3. Else use the last completed task in array order (covers single `task` workflows and `agent` delegate runs).
4. Read its `files.output`. If `output.format === "json"`, parse and render the structured JSON into readable Markdown so the judge sees the full deliverable, not just one primary field.

Record the chosen `taskId` in the internal manifest for auditability.

## Blind normalization

- Strip run ids, workflow artifact paths, explicit arm type/name labels, generated eval spec names, markdown heading markers, and run metadata.
- Keep final answer, evidence/citations, recommended actions, and task-relevant source file references.
- Write `output-A.md`, `output-B.md`, and optional additional blind labels such as `output-C.md` with randomized blind labels.
- Save `mapping.json` internally with both blind-label mapping and configured arm mapping.

## Metadata (hidden)

From `run.json`/tasks per arm: `status`, task count, completed/failed/skipped/blocked/interrupted counts, basic elapsed/wall-clock fields, and token/cost placeholders left `null` in MVP.

Save to `internal/<task-id>/arm-<label>/metadata.json`. Also write a top-level `manifest.json` with git commit/dirty status, runner/task/rubric/judge prompt hashes, workflow/agent file hashes, model/thinking settings, effective settings when explicit or `default-unresolved` when ambient, fixture paths and hashes, answer-key presence, coverageCriteria presence, Pi version, Node version, platform, and architecture.

## Hidden answer-key checks

For tasks with `answerKey`, run an objective post-check after blind outputs are created:

- The answer key is never passed to arms or blind judges.
- Each `knownIssues[]` item may define `matchAny`, an array of term sets, and optional `defectMarkers`.
- Before matching, fenced code blocks and unified-diff quote lines are stripped from the matcher input; Markdown bullets must be preserved.
- A known issue is found only when every term from one term set appears within a bounded proximity window and co-occurs with a distinct defect marker such as `missing`, `removed`, `ignored`, `bypass`, `unsafe`, or `regression`.
- Obvious nearby negation (`not`, `cannot`, `no`, etc.) rejects a candidate match.
- Missing ids listed in `hardFailureIfMissed` are reported as objective hard misses.
- Write `internal/<task-id>/answer-key-results.json` and summarize coverage in the operational section of `report.md`.

This check is intentionally simple and auditable; it complements, not replaces, blind output scoring.

## LLM judge scoring

- Score each arm independently in its own judge session.
- Per-session judge input: task brief + one normalized output + rubric + JSON schema. Never both arms together.
- Call judge via Pi non-interactive `-p` with the judge prompt. Judge model/thinking defaults to the user's current setting and is overridable by a runner flag.
- Derive winner from independent means: rank by fewest hard failures then highest mean; otherwise only differences greater than one rubric point across one dimension (`1 / dimensionCount`) produce a winner; smaller differences are ties.
- Parse JSON scores; store `scores/<task-id>.json`.
- Out of scope (MVP): pairwise comparison, reversed-order passes, multi-judge calibration.

## Aggregate report

- Section 1: blind scores + winners + hard failures (no metadata).
- Section 2: reveal mapping, attach hidden metadata, compute quality-vs-cost notes.
- Write `results/<timestamp>/report.md`.

## Build steps

```text
1. .pi/eval/ab-execution/{rubric.md, judge-prompt.md, tasks.json}  -> verify: files exist, tasks.json parses
2. run.mjs: arm execution + wait + run.json read              -> verify: arms produce completed run ids or direct outputs
3. final-output extraction + blind package                     -> verify: output-<label>.md files created, mapping hidden
4. metadata collection                                         -> verify: metadata.json per arm
5. hidden answer-key check for seeded tasks                    -> verify: answer-key-results.json
6. judge scoring                                               -> verify: scores/<task>.json valid JSON
7. manifest capture                                            -> verify: manifest.json has git/config/arm hashes
8. aggregate report                                            -> verify: report.md has blind and hidden/objective sections
```

## Resolved decisions

1. Judge model/thinking: default to the user's current model/reasoning; overridable via runner flag.
2. Scoring: independent per-arm sessions only. No pairwise/reversed-order in MVP; accuracy work deferred.
3. Generated workflow files for model/reasoning override: written to a dedicated eval directory, not `.pi/workflows/`.
