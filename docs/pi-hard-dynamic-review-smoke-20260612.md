# Pi hard dynamic-review smoke — 2026-06-12

## Scope

Added external pinned `earendil-works/pi` dynamic-review candidates at commit `daab056ac16d2aa7447f99205ae6e3d1c19ecfa6`.

New candidate registries:

- `.pi/eval/dynamic-review/tasks.pi-hard-candidates.json`
- `.pi/eval/dynamic-review/tasks.pi-hard-composite.json`

New seeded areas:

1. `OutputAccumulator` split UTF-8 streaming decode regression.
2. `prepareBranchEntries` extension-provided `branch_summary.fromHook` file-op leak.
3. `truncateTail` multi-byte UTF-8 byte-limit overrun.
4. Composite task combining all three in one patch.

## Low smoke results

Kimi model/thinking: `kimi-coding/kimi-for-coding`, `low`.

```text
.pi/eval/dynamic-review/runs/run-20260612T191714Z
pi-output-accumulator-utf8-stream:       A 6/6, B 6/6, C 6/6
pi-branch-summary-hook-fileops:          A 6/6, B 6/6, C 6/6
pi-truncate-tail-byte-boundary:          A 6/6, B 6/6, C 6/6

.pi/eval/dynamic-review/runs/run-20260612T192740Z
pi-coding-agent-output-context-composite: A 18/18, B 18/18, C 18/18
```

## Interpretation

These fixtures are valid regression/smoke tasks: baseline pass and seeded RED were manually verified, and all arms produced targeted RED/GREEN evidence.

They are still weak A/B discriminators. Even the composite task ceilinged at Kimi-low. Future hard holdout should use larger or less local patches where the defect is not visible as an obvious single-line invariant break in `git diff`.

## Scoring note

Dynamic scores now include:

```json
"commandEvidence": {
  "source": "candidate-reported",
  "independentlyVerified": false
}
```

This is intentionally minimal. Tool-level command telemetry reconstruction remains a separate follow-up.
