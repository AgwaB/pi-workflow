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

- The current recovered compiler still represents `foreach` stages with a static placeholder task rather than full dynamic fanout.
- The completed run therefore surfaced coverage gaps explicitly, but it did not execute every planned research question as separate subagent work.
- The result is valid evidence of execution readiness and output-shape viability, not proof that the workflow performs exhaustive research.

## Follow-up hardening

1. Restore/complete true dynamic foreach materialization from prior stage JSON arrays.
2. Add deterministic tests for stage `from` dependencies and `workflow-v1` DAG scheduling.
3. Add an E2E scenario for non-interactive tmux fallback with no pre-existing tmux server.
4. Keep A/B claims diagnostic; do not generalize one local task to universal workflow superiority.
