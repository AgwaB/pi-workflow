# geth locked-controls GPT-5.5 low fast run analysis

Run: `.pi/eval/bug-forge/runs/geth-locked-controls-gpt55-codex-low-fast-20260617T155426Z`

## Scope

- Tasks: `geth-case-002`, `geth-case-004`, `geth-control-001`, `geth-control-002`.
- Arms: plain, self-check, workflow.
- Model: `openai-codex/gpt-5.5`, thinking `low`.
- Mode: fast partition-only workflow (`--workflow-no-report --allow-partition-only --workflow-score-stage partition`).

## Raw result

Raw first-run scores are preserved in per-cell `score.json` and aggregate `report.md`.

Key raw observation: `geth-case-002` exposed incomplete gold. Self-check/workflow flagged a real Start/setup error that was not in the old one-bug gold.

## Gold review

Provider review artifacts:

- `.pi/eval/bug-forge/provider-reviews/geth-case-002-gold-review-20260618/geth-case-002-gpt55-high-review.md` — returned `NEEDS_CHANGES`; current G1 valid but add G2/G3.
- `.pi/eval/bug-forge/provider-reviews/geth-case-002-gold-review-20260618/geth-case-002-expanded-gpt55-high-review.md` — returned `APPROVE` for expanded G2/G1/G3 gold.

## Gold-reviewed rescore

Use `gold-reviewed-rescore.md` / `gold-reviewed-rescore.json` for interpretation. Raw `score.json` files were not modified.

Mean objective scores after rescore:

- plain: `0.985`
- self-check: `0.919`
- workflow: `0.919`

## Interpretation

- `geth-case-004` and both no-issue controls were cleanly handled by all arms.
- On expanded `geth-case-002`, plain caught G2+G1 and missed G3.
- Self-check and fast workflow caught G2 only.
- This run is useful as a compact regression/precision smoke, not as evidence of workflow advantage.

## Next actions

1. Run a full workflow rerun on `geth-case-002` plus controls to see whether report/dedup stages recover G1.
2. Keep searching for production geth cases where plain GPT-5.5 recall is below saturation.
3. Keep `geth-case-007` out of primary gate until leakage mitigation.
