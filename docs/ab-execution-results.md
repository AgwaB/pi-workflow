# A/B Execution Results

This document records current local diagnostic evaluation evidence for `pi-workflow`. Raw evaluator artifacts live under `.pi/eval/ab-execution/` and are local execution evidence, not packaged release assets.

## Current active setup

- Runner: `.pi/eval/ab-execution/run.mjs`
- Task config: `.pi/eval/ab-execution/tasks.json`
- Rubric: `.pi/eval/ab-execution/rubric.md`
- Judge prompt: `.pi/eval/ab-execution/judge-prompt.md`
- Execution model: `kimi-coding/kimi-for-coding`
- Judge model: `kimi-coding/kimi-for-coding`
- Baseline: plain single Pi, with no specialist/persona wrapper
- Active bundled workflow arms: `deep-research`, `deep-review`

The runner performs blind judging of anonymized final outputs first, then reveals operational metadata and hidden answer-key coverage where available.

## Latest real Kimi diagnostic runs

### `review-seeded-safety-diff`

Raw report: `.pi/eval/ab-execution/runs/run-20260608T100947Z/report.md`

| Arm | Configured execution | Status | Blind score | Hidden answer-key coverage |
| --- | --- | --- | --- | --- |
| A | `workflow:deep-review` | completed, 13/13 tasks | 4.50 | 2/3 |
| B | `plain:single-pi` | completed, 1/1 task | 4.83 | 2/3 |

Blind winner: plain single Pi. Hidden answer-key winner: configured tie. Both arms missed the same seeded matcher criterion (`seed-001-worker-role-removed`).

### `research-agent-evals`

Raw report: `.pi/eval/ab-execution/runs/run-20260608T133951Z/report.md`

| Configured arm | Blind label | Status | Blind score |
| --- | --- | --- | --- |
| `workflow:deep-research` | B | failed operationally; final JSON valid; 36 tasks, 34 completed, 2 interrupted | 4.83 |
| `plain:single-pi` | C | completed, 1/1 task | 4.83 |
| `parallel5:researcher` | A | completed, 6/6 tasks | 4.83 |

Blind winner: tie.

Important operational caveat: `workflow:deep-research` produced a valid `finalReport` and `evidencePacket`, but two `verify-claims` tmux panes disappeared before result capture (`pane_missing`, empty output/stderr, no result JSON). Therefore this is useful quality-comparison evidence, but not clean workflow operational-success evidence.

## Bugs and hardening found by real execution

Real Kimi execution exposed issues that dry-run/mock checks did not catch:

1. Generated workflow spec paths were shell-quoted in a way `/workflow run` could not parse.
2. A/B report generation referenced a missing `formatMean` helper.
3. Non-interactive workflow execution failed when no tmux server existed; tmux launch now falls back to a detached session.
4. Stage-first workflows were being scheduled like flat parallel runs instead of dependency-aware `workflow-v1` runs.
5. `foreach` placeholder tasks could receive empty prompts after recovery.
6. `waitForRun()` ignored nonzero `/workflow wait` exits, allowing premature scoring of a still-running workflow.
7. `/workflow wait` had a 30-minute maximum clamp; long real research runs now allow a longer wait window.
8. `deep-research` inherited the default 30-minute per-task runtime; long verifier tasks now use a larger workflow runtime budget.
9. JSON output validation was less robust than the standalone parser and could reject recoverable fenced/prose-wrapped JSON.
10. JSON output retry left `pid`/`startedAt` on pending tasks, preventing relaunch.
11. `deep-research` normalization could exceed model output length; the normalize prompt now requires compact JSON and a tighter standard verification-candidate cap.
12. A/B operational report lines hid `interrupted` task counts; the runner now includes them.

## Interpretation

This evidence is diagnostic only. It shows:

- Plain single Pi remains a strong baseline.
- `deep-review` did not beat plain Pi on this seeded safety fixture; objective hidden coverage tied.
- `deep-research`, plain Pi, and `parallel5:researcher` tied under the Kimi blind judge on this research task, while `deep-research` generated substantially more structured workflow evidence but had two infrastructure interruptions.

It does not prove that workflows generally outperform plain Pi, nor that the A/B suite is release-grade.

## Related deep-research validation

See `docs/deep-research-validation-20260608.md` for real Kimi `deep-research` runs and dynamic-foreach validation evidence.
