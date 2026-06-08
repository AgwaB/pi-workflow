# A/B Execution Results

This document records current local diagnostic evaluation evidence for `pi-workflow`. Raw evaluator artifacts live under `.pi/eval/ab-execution/` and are local execution evidence, not packaged release assets.

## Current active setup

- Runner: `.pi/eval/ab-execution/run.mjs`
- Task config: `.pi/eval/ab-execution/tasks.json`
- Rubric: `.pi/eval/ab-execution/rubric.md`
- Judge prompt: `.pi/eval/ab-execution/judge-prompt.md`
- Execution model: `kimi-coding/kimi-for-coding`
- Baseline: plain single Pi, with no specialist/persona wrapper
- Active bundled workflow arms: `deep-research`, `deep-review`

The runner performs blind judging of anonymized final outputs first, then reveals operational metadata and hidden answer-key coverage where available.

## Latest real Kimi run

- Initial real run after workflow-only runner cleanup: `.pi/eval/ab-execution/runs/run-20260608T063453Z/report.md`
- Final rejudge after the workflow completed and wait handling was fixed: `.pi/eval/ab-execution/runs/run-20260608T070904Z/report.md`

Task: `review-seeded-safety-diff`

| Arm | Configured execution | Status | Blind score | Hidden answer-key coverage |
| --- | --- | --- | --- | --- |
| A | `workflow:deep-review` | completed, 4/4 tasks | 4.83 | 3/3 |
| B | `plain:single-pi` | completed, 1/1 task | 4.67 | 3/3 |

Blind winner: tie. Hidden answer-key winner: tie.

## Bugs found by real execution

The real Kimi run exposed issues that dry-run/mock checks did not catch:

1. Generated workflow spec paths were shell-quoted in a way `/workflow run` could not parse.
2. A/B report generation referenced a missing `formatMean` helper.
3. Non-interactive workflow execution failed when no tmux server existed; tmux launch now falls back to a detached session.
4. Stage-first workflows were being scheduled like flat parallel runs instead of dependency-aware `workflow-v1` runs.
5. `foreach` placeholder tasks could receive empty prompts after recovery.
6. `waitForRun()` ignored nonzero `/workflow wait` exits, allowing premature scoring of a still-running workflow.

## Interpretation

This evidence is diagnostic only. It shows that the active `deep-review` workflow can run through real Kimi subagents and match the plain baseline on the seeded safety diff. It does not prove that workflows generally outperform plain Pi, nor that the A/B suite is release-grade.

## Related deep-research validation

See `docs/deep-research-validation-20260608.md` for real Kimi `deep-research` runs, including one failed xhigh/stuck final run and one bounded successful run.
