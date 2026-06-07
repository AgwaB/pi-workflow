# A/B Execution Rubric

Blind scoring rubric for comparing two execution arms (A and B) on the same task.

Each arm is scored independently in its own judge session. The judge sees only one
output at a time, never both, so there is no A/B ordering or position bias.

## Dimensions (score each 1-5, higher is better)

### correctness
Does the output identify true facts/findings and avoid false claims?
- 1: mostly incorrect or misleading
- 3: mixed; useful but with notable errors
- 5: accurate, well-calibrated, no material false claims

### completeness
Does the output cover the important aspects of the task?
- 1: misses most key points
- 3: covers some key points but misses important ones
- 5: covers the important dimensions with appropriate prioritization

### evidenceQuality
Are claims grounded in files, sources, quotes, commands, or reproducible evidence?
- 1: unsupported assertions
- 3: some evidence but uneven or vague
- 5: strong, specific, source-backed evidence

### actionability
Can a user act on the output?
- 1: vague or not actionable
- 3: useful direction but needs interpretation
- 5: clear next steps, priorities, and tradeoffs

### concision
Is the output appropriately concise and low-noise? Higher is better.
- 1: rambling, repetitive, or distracting
- 3: acceptable but could be tighter
- 5: concise without omitting important detail

### calibration
Does the output distinguish facts, inference, uncertainty, and caveats?
- 1: overconfident or uncalibrated
- 3: some caveats but inconsistent
- 5: clearly calibrated and honest about uncertainty

## Hard failures (record separately, not as 1-5)

Flag any that apply:

- `invalid-output`
- `failed-to-complete`
- `modified-files-in-read-only-task`
- `hallucinated-file-path`
- `unsupported-critical-claim`
- `missed-known-critical-issue`
- `unsafe-tool-use`

## Winner derivation (computed by the runner, not the judge)

```text
A_score = mean(correctness, completeness, evidenceQuality, actionability, concision, calibration)
B_score = mean(...)

if exactly one arm has a hard failure -> the other arm wins
else if |A_score - B_score| >= 0.01    -> higher mean wins
else                                    -> tie
```

The judge only scores one arm at a time. Winner is derived from the two
independent score sets. Pairwise comparison and reversed-order passes are out of
scope for the MVP.
