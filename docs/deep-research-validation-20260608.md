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
- `evidencePacket` keys: `claims`
- Evidence packet claims: 18
- Main findings: 5
- Remaining gaps: 6
- Coverage summary included counts for depth, researchQuestions, rawClaimsApprox, verificationCandidates, verified, partiallySupported, unsupported, conflicting, preserved, and coverageGaps.

## Interpretation

The bounded run demonstrates that `deep-research` can complete with real Kimi execution and produce the intended `finalReport` + `evidencePacket` shape.

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

Remaining hardening:

1. Run a full `deep-research` max/standard validation with restored fanout when cost/time are acceptable.
2. Keep A/B claims diagnostic; do not generalize one local task to universal workflow superiority.
