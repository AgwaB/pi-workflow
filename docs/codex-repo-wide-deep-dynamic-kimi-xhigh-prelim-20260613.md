# Codex repo-wide deep-dynamic-review — Kimi xhigh preliminary

Date: 2026-06-13

## Status

Preliminary result with **2 valid repetitions**. The planned third repetition was stopped because repo-wide Kimi xhigh runs were taking too long after earlier disk-pressure retries.

## Summary

On this broader, more ambiguous Codex repo-wide holdout, `deep-dynamic-review` shows a positive signal versus plain Kimi, but it still does not beat the compute-matched self-check baseline.

| Arm | Description | Scores /18 | Mean | Wins |
| --- | --- | ---: | ---: | ---: |
| A | `workflow:deep-dynamic-review` | 4, 7 | 5.500 | 0/2 |
| B | `plain` | 3, 3 | 3.000 | 0/2 |
| C | `plain-self-check` | 7, 11 | 9.000 | 2/2 |

Pairwise mean deltas:

- A − B: `+2.500` — workflow beat plain in both reps.
- A − C: `-3.500` — self-check beat workflow in both reps.
- B − C: `-6.000` — self-check beat plain in both reps.

## Setup

- Model: `kimi-coding/kimi-for-coding`
- Thinking: `xhigh`
- Target: `openai/codex` at `7cc80b39f1247beb9319228d9b3129c510763914`
- Workflow arm: `workflows/deep-dynamic-review/spec.json`
- Task registry: `.pi/eval/dynamic-review/tasks.codex-repo-wide-holdout.json`
- Fixture patch: `.pi/eval/dynamic-review/fixtures/codex-repo-wide-contracts-holdout/regression.patch`
- Private answer key: outside repo under `~/.pi/agent/eval-private/pi-workflow/dynamic-review-answer-keys/`
- Aggregate artifact: `docs/ab-artifacts/codex-repo-wide-deep-dynamic-kimi-xhigh-prelim-20260613.json`

Relevant commits:

- `22737ee` — repo-wide holdout + `deep-dynamic-review`
- `79a1ec0` — repo-wide scoring/prompt fixes after `claude-opus-4-8` review
- `5f56d74` — workspace cleanup guard after artifact errors

## Valid runs

| Rep | Run directory | Winner |
| ---: | --- | --- |
| 1 | `.pi/eval/dynamic-review/runs/codex-repo-wide-deep-dynamic-kimi-xhigh-rep1-20260613T034712Z` | C |
| 2 | `.pi/eval/dynamic-review/runs/codex-repo-wide-deep-dynamic-kimi-xhigh-rep2c-20260613T085412Z` | C |

Invalid/excluded attempts:

- `rep2-20260613T064702Z` — ENOSPC before artifact completion
- `rep2b-20260613T081344Z` — ENOSPC before artifact completion
- `rep3c-20260613T104746Z` — aborted after user chose preliminary reporting

## Telemetry and caveats

- All valid arms have actual Pi/bash telemetry in `actual-command-runs.json` and reconciled `verified-command-runs.json`.
- Trap penalties were zero for all valid arms.
- This is **not** a final 3+ rep holdout result; treat it as directional evidence.
- Directional conclusion: broader deep-review-style workflow improves over plain, but the self-check baseline remains stronger in this sample.

## Operational notes

- Disk pressure came from Codex Rust build artifacts and incomplete temp workspaces after failed runs.
- The Codex target cache was rebuilt so `codex-rs/target` can be symlinked into candidate workspaces.
- Aborted/failed run directories and large temp workspaces were cleaned where safe.
