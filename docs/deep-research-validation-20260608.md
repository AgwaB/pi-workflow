# Deep Research Live Validation — 2026-06-08

This report records real local executions of `workflows/deep-research.json` using Kimi for Coding subagents. No mock outputs were used.

## Execution target

- Workflow: `workflows/deep-research.json`
- Model: `kimi-coding/kimi-for-coding`
- Purpose: validate execution readiness, output structure, claim verification gating, and runaway/failure behavior.

## Run 1 — standard/xhigh diagnostic failure

- Run: `.pi/workflows/workflow_mq4vj82m_5c68e4`
- Thinking: `xhigh`
- Wait timeout: 1,800,000 ms
- Result: `failed` after manual local tmux interruption of a stuck final stage.
- Task summary: 4 completed, 1 interrupted, 0 failed.

Observed behavior:

- `plan.main`, `research-questions.item`, `normalize-claims.main`, and `verify-claims.item` completed with real Kimi output.
- `final.main` produced no output/stderr and remained running beyond the wait timeout.
- The run exposed two product issues:
  1. stage-first compiled tasks did not carry a runtime timeout before the fix;
  2. final synthesis needed bounded-output instructions to avoid runaway generation.

Important caveat: this is a diagnostic failed run, not a usable research result.

## Fixes made after Run 1

- Stage-first compiler now propagates:
  - top-level/default/stage model and thinking;
  - top-level/default/stage tools;
  - `maxRuntimeMs` with a safe default.
- Stage-first scheduler now treats `workflow-v1` as dependency-aware rather than flat parallel.
- Stage-first compiler now uses explicit `from` dependencies where present.
- `foreach` placeholder prompts are no longer empty; runtime task injection remains deferred for foreach.
- `deep-research` final prompt now asks for bounded synthesis rather than unbounded expansion.

## Run 2 — bounded/high completed validation

- Run: `.pi/workflows/workflow_mq4woymd_e076fb`
- Generated spec: `.tmp/live-validation/deep-research-kimi-bounded-20260608T074527Z.json`
- Model: `kimi-coding/kimi-for-coding`
- Thinking: `high`
- Per-stage timeout in generated spec: `600000` ms
- Result: `completed`
- Task summary: 5 completed, 0 failed, 0 skipped, 0 interrupted.

Completed stages:

| Stage | Status |
| --- | --- |
| `plan.main` | completed |
| `research-questions.item` | completed |
| `normalize-claims.main` | completed |
| `verify-claims.item` | completed |
| `final.main` | completed |

Final output structure check:

- `finalReport` keys: `summary`, `coverageSummary`, `mainFindings`, `caveatedFindings`, `contestedAreas`, `notableUnsupportedClaims`, `researchScopeCoverage`, `remainingGaps`
- `claimVerdictIndex` keys: `claims`
- Claim verdict index claims: 18
- Main findings: 5
- Remaining gaps: 6
- Coverage summary included counts for depth, researchQuestions, rawClaimsApprox, verificationCandidates, verified, partiallySupported, unsupported, conflicting, preserved, and coverageGaps.

## Interpretation

The bounded run demonstrated that `deep-research` could complete with real Kimi execution and produce the then-current `finalReport` + claim-index shape. The current workflow has since evolved to use `claimVerdictIndex`, with full evidence retained in verifier task artifacts.

Do not overclaim from this run:

- This run was completed before full dynamic `foreach` fanout was restored.
- The completed run surfaced coverage gaps explicitly, but it did not execute every planned research question as separate subagent work.
- The result is valid evidence of execution readiness and output-shape viability, not proof that the workflow performs exhaustive research.

## Dynamic foreach restoration follow-up

After this validation, dynamic `foreach` fanout was restored with these semantics from the historical workflow model:

- `from.path` reads a simple dot path such as `$.claims` from prior structured output.
- all extracted items expand into generated tasks;
- item object `id` values are sanitized into generated task ids, otherwise `item-001` style ids are used;
- duplicate generated ids block expansion;
- `maxItems` is optional; when present, overflow blocks; when absent, expansion is unlimited;
- `maxConcurrency` controls stage concurrency, not item count;
- downstream dependencies are rewired to all generated item tasks.

Additional real Kimi validation after restoring fanout:

- `workflow_mq4yqpz4_ece5b1`: synthetic dynamic-foreach smoke, completed 4/4 with generated tasks `verify.alpha` and `verify.beta`, and final reduce depending on both.
- `workflow_mq4y2dq4_c5d8ab`: `deep-review` seeded fixture, completed 9/9 with generated reviewer and devil-advocate foreach tasks.

## Run 3 — restored dynamic fanout quick validation

- Run: `.pi/workflows/workflow_mq4zr1kr_3ae28e`
- Generated spec: `.tmp/live-validation/deep-research-dynamic-kimi-quick-20260608T091103Z.json`
- Model: `kimi-coding/kimi-for-coding`
- Thinking: `high`
- Result: `completed`
- Task summary: 24 completed, 0 failed, 0 skipped, 0 interrupted.

Dynamic fanout evidence:

| Stage | Generated/completed tasks |
| --- | ---: |
| `plan` | 1/1 |
| `research-questions` | 5/5: `rq1` ... `rq5` |
| `normalize-claims` | 1/1 |
| `verify-claims` | 16/16: `claim-001` ... `claim-016` |
| `final` | 1/1 |

The final report included `finalReport` and a structured claim index. The run verified that restored dynamic fanout now performs multi-question research and per-claim verification in a real Kimi execution.

Observed issue from Run 3:

- `verify-claims.claim-004` completed with a JSON output warning because the verifier produced prose instead of a strict JSON object.

Follow-up fix applied:

- `verify-claims` output now sets `onInvalid: "fail"`, which triggers the existing invalid-output retry path instead of silently recording a warning.
- The verifier prompt now explicitly forbids prose, markdown fences, commentary, or text outside the JSON object.

## Run 4 — standard-depth A/B diagnostic execution

- A/B run: `.pi/eval/ab-execution/runs/run-20260608T133951Z/report.md`
- Workflow run: `.pi/workflows/workflow_mq59cqo7_f22c07`
- Model: `kimi-coding/kimi-for-coding`
- Thinking: `high`
- Result: operational `failed`, but final synthesis completed with valid JSON.
- Task summary: 36 total, 34 completed, 0 failed, 0 blocked, 2 interrupted.

Dynamic fanout evidence:

| Stage | Generated/completed tasks |
| --- | ---: |
| `plan` | 1/1 completed |
| `research-questions` | 8/8 completed |
| `normalize-claims` | 1/1 completed |
| `verify-claims` | 25 generated; 23 completed; 2 interrupted |
| `final` | 1/1 completed |

Final output structure check:

- `final.main` output validation: valid JSON
- Top-level keys: `finalReport`, structured claim index

Operational caveat:

- `verify-claims.claim-023` and `verify-claims.claim-024` were marked `interrupted/pane_missing`.
- Their output and stderr logs were empty and no result JSON was recorded.
- This appears to be tmux launch/early-exit capture behavior, not a verifier answer-quality failure.
- The final stage completed under partial-source policy, so the research artifact exists but the workflow run is not clean operational-success evidence.

Hardening applied during this A/B cycle:

- `/workflow wait` maximum timeout was raised from 30 minutes to 4 hours.
- `deep-research` default task runtime was raised to 4 hours.
- JSON output validation now uses the robust parser path that can recover valid object candidates from fenced/prose-wrapped output.
- Invalid JSON retry now clears `pid`, `startedAt`, `completedAt`, and launch metadata so pending retries can relaunch.
- Retry prompts now include the same task's invalid output attempt, not an unrelated previous dependency.
- `normalize-claims` now asks for compact JSON with a tighter standard-depth verification-candidate cap to avoid model output truncation.

Remaining hardening:

1. Investigate/mitigate `pane_missing` for short-lived empty tmux panes.
2. Keep A/B claims diagnostic; do not generalize one local task to universal workflow superiority.
