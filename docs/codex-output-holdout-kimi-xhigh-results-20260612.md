# Codex output-contract dynamic-review holdout — Kimi xhigh A/B/C

Date: 2026-06-12

## Summary

On the new Codex output-contract holdout, the `dynamic-review` workflow arm did **not** outperform the plain Kimi baselines. The compute-matched `plain-self-check` arm won all 3 repetitions.

| Arm | Description | Scores /18 | Mean | Wins |
| --- | --- | ---: | ---: | ---: |
| A | `workflow:dynamic-review` | 8, 11, 12 | 10.333 | 0/3 |
| B | `plain` | 11, 14, 15 | 13.333 | 0/3 |
| C | `plain-self-check` | 15, 15, 17 | 15.667 | 3/3 |

Pairwise mean deltas:

- A − B: `-3.000`
- A − C: `-5.333`
- B − C: `-2.333`

## Setup

- Model: `kimi-coding/kimi-for-coding`
- Thinking: `xhigh`
- Target: `openai/codex` at `7cc80b39f1247beb9319228d9b3129c510763914`
- Task registry: `.pi/eval/dynamic-review/tasks.codex-tools-output-holdout.json`
- Fixture patch: `.pi/eval/dynamic-review/fixtures/codex-tools-output-contract-holdout/regression.patch`
- Fixture freeze commit: `4feaebe`
- Telemetry propagation commit: `64d967d`
- Private answer key: outside repo under `~/.pi/agent/eval-private/pi-workflow/dynamic-review-answer-keys/`
- Aggregate artifact: `docs/ab-artifacts/codex-output-holdout-kimi-xhigh-20260612.json`

## Runs

| Rep | Run directory | Winner |
| ---: | --- | --- |
| 1 | `.pi/eval/dynamic-review/runs/codex-output-holdout-kimi-xhigh-telemetry-rep1-20260612T215844Z` | C |
| 2 | `.pi/eval/dynamic-review/runs/codex-output-holdout-kimi-xhigh-telemetry-rep2-20260612T221744Z` | C |
| 3 | `.pi/eval/dynamic-review/runs/codex-output-holdout-kimi-xhigh-telemetry-rep3-20260612T223337Z` | C |

## Telemetry

All arms have Pi bash telemetry artifacts:

- `actual-command-runs.json` records actual command, cwd, exit code, combined output excerpt, `startedAt`, `completedAt`, and `elapsedMs`.
- `verified-command-runs.json` reconciles candidate-reported `commandRuns` with actual Pi bash events.
- `matchedCount` is candidate-reported commands matched to actual events.
- `unmatchedActualCount` is actual bash commands not listed in the final JSON.

## Interpretation

This holdout is stronger evidence against a current `dynamic-review` workflow advantage for Kimi on this Codex task. The workflow arm consistently underperformed both baselines, while self-check improved over plain in all three reps. Trap penalties were zero for all arms, so the spread is primarily from missed targeted repro tests and missing/partial RED/GREEN evidence rather than false positives.
