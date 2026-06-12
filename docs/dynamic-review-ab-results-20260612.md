# Dynamic Review Kimi-only A/B Results — 2026-06-12

## Scope

This report covers the dynamic-review suite only: runner-applied patch review tasks where each arm can write targeted repro tests and report RED/GREEN evidence.

Broader suites from the master plan (static review, deep research, implementation/repair) were not expanded in this run. The dynamic-review suite was the primary planned discriminator and is the only suite with new large-run evidence here.

## Frozen setup

- Freeze commit: `fe88465` (`Freeze dynamic-review pilot and holdout fixtures`)
- Runner: `.pi/eval/dynamic-review/run.mjs`
- Workflow arm: `workflows/dynamic-review/spec.json`
- Model: `kimi-coding/kimi-for-coding`
- Pilot thinking: `low`
- Holdout thinking: `xhigh`
- Arms:
  - A: `workflow:dynamic-review`
  - B: `plain`
  - C: `plain-self-check`
- Arm concurrency: `3`
- Scorer: `dynamic-review-v1-artifact-scorer`
- Answer keys: private files under `~/.pi/agent/eval-private/pi-workflow/dynamic-review-answer-keys/`

## Runs

### Pilot / calibration

```text
.pi/eval/dynamic-review/runs/run-20260612T155738Z
```

5 tasks × 3 arms × Kimi low × 1 replicate.

Pilot exposed one scorer edge case: exact `testSignals` missed clear command evidence where the command included the issue symbol plus fail/pass semantics. This was fixed before holdout and recorded in freeze commit `fe88465`.

### Xhigh holdout

Frozen holdout runs:

```text
.pi/eval/dynamic-review/runs/run-20260612T161420Z
.pi/eval/dynamic-review/runs/run-20260612T164518Z
.pi/eval/dynamic-review/runs/run-20260612T171623Z
```

10 holdout tasks × 3 arms × 3 replicates = 90 arm executions.

## Holdout aggregate

| Arm | n | Mean objective score | Perfect 6/6 | RED evidence | GREEN evidence | Trap penalty | Hard failures |
|---|---:|---:|---:|---:|---:|---:|---:|
| A workflow | 30 | 5.633 | 24/30 | 30/30 | 30/30 | 0 | 0 |
| B plain | 30 | 5.600 | 20/30 | 30/30 | 28/30 | 0 | 0 |
| C self-check | 30 | 5.567 | 24/30 | 29/30 | 30/30 | 0 | 0 |

Task-level paired differences averaged over 3 replicates per task:

| Comparison | Mean paired diff | Bootstrap 95% CI over tasks |
|---|---:|---:|
| workflow - plain | +0.033 | [-0.233, +0.267] |
| workflow - self-check | +0.067 | [-0.067, +0.233] |

## Interpretation

The dynamic workflow did **not** produce a statistically meaningful win on this holdout.

Observations:

- All arms were near ceiling on this fixture set.
- Workflow had the highest raw mean, best GREEN rate, and no trap/hard failures.
- The margins versus both baselines were very small.
- Bootstrap confidence intervals include zero, so the victory criteria from the master plan are not met.
- Trap false positives were zero for every arm, so this suite did not differentiate precision.

Conclusion for this run:

```text
No evidence that pi-workflow dynamic-review outperforms direct Kimi baselines on this 10-task xhigh holdout.
```

This is a useful negative/near-ceiling result, not a workflow win.

## Task-level notes

Most tasks saturated at 6/6. Differentiating tasks were:

- `rate-limiter-max-attempt-dynamic-review-v1`: all arms struggled; workflow beat self-check on average but trailed plain.
- `invoice-tax-rounding-dynamic-review-v1`: plain won two of three replicates; workflow/self-check varied.
- `password-min-length-dynamic-review-v1`: workflow had the strongest average.

## Limitations

- Dynamic-review only; static review, research, and implementation/repair suites were not run at scale.
- Holdout size was 10 tasks, not the original 15–20 target.
- Scoring uses candidate-reported `commandRuns` plus captured diffs/log artifacts. It does not independently reconstruct every shell command from low-level Pi tool telemetry yet.
- The fixtures were small Node.js projects; results may not transfer to larger repos.
- Many tasks were too easy for Kimi xhigh, causing near-ceiling scores.

## Artifacts

Machine-readable aggregate:

```text
docs/ab-artifacts/dynamic-review-kimi-holdout-20260612.json
```

Primary run artifacts remain under:

```text
.pi/eval/dynamic-review/runs/
```

## Commands used

Pilot:

```bash
node .pi/eval/dynamic-review/run.mjs \
  --run \
  --tasks .pi/eval/dynamic-review/tasks.pilot.json \
  --arms A,B,C \
  --arm-concurrency 3 \
  --model kimi-coding/kimi-for-coding \
  --thinking low \
  --timeout-ms 2700000
```

Holdout replicates:

```bash
node .pi/eval/dynamic-review/run.mjs \
  --run \
  --tasks .pi/eval/dynamic-review/tasks.holdout.json \
  --arms A,B,C \
  --arm-concurrency 3 \
  --model kimi-coding/kimi-for-coding \
  --thinking xhigh \
  --timeout-ms 3600000
```
