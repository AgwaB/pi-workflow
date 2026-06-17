# Bug Forge / deep-review next steps

Updated after current HEAD:

- `6899c58 Fix workflow run argument parsing`
- `8322225 workflow: preserve patch locations in deep-review prompts`
- `2a5a478 eval: refine geth gold keys after pilot review`
- `143af71 eval: add hard geth bug-forge pilot tasks`
- `65ebbe0 eval: match findings with exact evidence support locations`

Validation after `6899c58`:

- `npm test` — 122/122 passed.
- `npm run typecheck` — passed.
- `node .pi/eval/bug-forge/scripts/validate.mjs` — passed, `checkedTasks: 35`.
- `lens_diagnostics mode=all severity=error` — no errors.

## Current benchmark state

### Usable smoke/regression tasks

- `geth-case-001`: p2p/discover waitForNodes deadlock.
  - Full-location smoke after prompt fix passed: `.pi/eval/bug-forge/runs/geth-case001-full-location-smoke-20260617T151523Z/`.
  - Now useful as a regression for patch-location preservation.
- `geth-case-003`: eth_simulateV1 fork-gated withdrawals fields.
- `geth-case-006`: tracer Stop/GetResult data race.
- `geth-case-008`: snap testPeer counter race; test-only, mostly smoke.

### Current strongest discriminator

- `geth-case-002`: txpool locals journal data race.
  - First geth pilot: plain/self-check missed; workflow caught.
  - Keep as primary recall discriminator.

### Needs provider/gold review before primary gate

- `geth-case-004`: nil-vs-empty getBlobs JSON contract.
  - Local gold evidence fixed; reviewed rescore improves workflow.
  - External/provider review still pending.
- `geth-case-007`: snapshot generator lifecycle.
  - Local gold now includes G2 for `genAbort` repeated-send/deadlock.
  - Needs provider review because fixture creates multiple related lifecycle issues.

### Demote / weak discriminators

- P16-AA27 local holdout is saturated for GPT-5.5; keep for smoke/regression only.
- `geth-case-001`, `003`, `006`, `008` are useful but mostly saturated under GPT-5.5 low.

## Impact of latest workflow commit

### `6899c58 Fix workflow run argument parsing`

Status: completed/validated.

Why it matters:

- Removes a runner ergonomics risk where quoted task text containing strings like `--detach` or `--model=...` could be misparsed as workflow run options.
- This supports future benchmark prompts/diffs that mention command-line flags literally.

Remaining follow-up from this commit:

- No immediate code change required.
- Keep as regression coverage; if future eval prompts include literal CLI flags, prefer quoted task text and rely on the new parser tests.

### `8322225 workflow: preserve patch locations in deep-review prompts`

Status: completed/smoke validated.

Why it matters:

- Fixes the observed full-report issue where the model found the right root but reported support/control-flow locations instead of the changed patch hunk.
- `geth-case-001` full-location smoke scored 1.000 after the prompt update.

Remaining follow-up:

- Add/keep future regression tasks where the correct evidence is a diff hunk but the causal explanation needs support locations.
- Watch for overcorrection: reviewers should include patch location first, but still include support locations when relevant.

## Adjusted priority list

### P0 — preserve benchmark validity

1. Provider/gold review for `geth-case-004`.
   - Confirm nil/null evidence update is acceptable.
   - If approved, mark as provider-reviewed or promote to gate candidate.
2. Provider/gold review for `geth-case-007`.
   - Decide whether G1+G2 should both remain gold bugs or whether fixture should be narrowed.
3. Preserve raw vs reviewed scores separately.
   - Do not overwrite existing `score.json` artifacts.
   - Use `gold-reviewed-rescore.*` for post-review interpretation.

### P1 — find harder OSS tasks

4. Continue mining geth or another OSS repo for production concurrency/state tasks.
   - Prioritize tasks where plain GPT-5.5 recall plausibly drops below 1.
   - Best patterns so far: production data races, shutdown/lifecycle races, state-machine/fork-boundary issues.
5. Avoid adding many test-only races as primary discriminators.
   - They are useful for smoke but too easy for GPT-5.5.
6. Add at least 2 no-issue OSS controls.
   - Needed to measure workflow over-reporting on real-looking patches.

### P2 — repeat/variance checks

7. Rerun a compact locked subset after provider review.
   - Suggested subset: `geth-case-002`, `geth-case-004`, `geth-case-007`, one no-issue control.
   - Run both fast and full workflow if budget allows.
8. Track variance separately from raw first-run evidence.
   - First-run outputs remain calibration evidence.

### P3 — workflow/scorer polish

9. Monitor duplicate/root splitting.
   - `geth-case-005` and fast `geth-case-007` showed precision pressure.
   - Full report often improves this; do not over-tune based on partition-only fast mode alone.
10. Consider a deterministic report-side normalization test for patch-location preservation.
    - Prompt smoke passed, but code-level regression could be stronger if the same failure recurs.
11. Keep exact-evidence support-location scorer fallback conservative.
    - It should require exact required evidence; do not loosen to semantic-only same-file matches.

## Current command snippets

Validate benchmark:

```bash
node .pi/eval/bug-forge/scripts/validate.mjs
```

Run GPT-5.5 bug-forge A/B fast mode from a clean worktree:

```bash
node .pi/eval/bug-forge/scripts/calibrate.mjs \
  --tasks geth-case-002,geth-case-004,geth-case-007 \
  --arms plain,self-check,workflow \
  --model openai-codex/gpt-5.5 \
  --thinking low \
  --concurrency 2 \
  --pi-extension-root "$WT" \
  --workflow-extension-root "$WT" \
  --workflow-no-report \
  --allow-partition-only \
  --workflow-score-stage partition \
  --out .pi/eval/bug-forge/runs/<run-id>
```

## Local hygiene

- Current tracked tree is clean at the time of this note.
- `.gjc/` remains untracked and unrelated.
- Keep eval run directories uncommitted unless a compact artifact is explicitly needed.

## Provider review update 2026-06-18

Provider review artifacts:

- `.pi/eval/bug-forge/provider-reviews/geth-gold-review-20260618/geth-case-004-gpt55-high-review.md`
- `.pi/eval/bug-forge/provider-reviews/geth-gold-review-20260618/geth-case-007-gpt55-high-review.md`

Results:

- `geth-case-004`: `APPROVE`.
  - Nil/null evidence correction accepted.
  - Marked as `locked-provider-reviewed-gpt55` in registry.
  - Keep API contract comments as secondary accepted evidence, but requiredEvidence remains marshaler-focused for deterministic validation.
- `geth-case-007`: `NEEDS_CHANGES`.
  - G1 and G2 are real and separable.
  - Not suitable as primary gate until candidate-visible regression tests/comments are masked or the task is rebuilt from an earlier source revision.
  - Marked as `draft-needs-leakage-mitigation` in registry.

Adjusted next action:

1. Promote `geth-case-004` to the compact locked subset candidate.
2. Keep `geth-case-007` in draft/diagnostic bucket only.
3. Build at least one real no-issue OSS control before another primary A/B run.

## OSS no-issue controls update 2026-06-18

Added and provider-reviewed two go-ethereum no-issue controls:

- `geth-control-001`: comment-only `NewHexOrDecimal256` wording patch. GPT-5.5 high review: `APPROVE`.
- `geth-control-002`: behavior-preserving `NewTx` local refactor. GPT-5.5 high review: `APPROVE`.

Validation evidence:

- `node .pi/eval/bug-forge/scripts/validate.mjs` passed with `checkedTasks: 37`.
- Materialized both controls with `BUG_FORGE_GETH_REPO=/tmp/pi-github-repos/ethereum/go-ethereum`.
- `go test ./common/math` passed for `geth-control-001`.
- `go test ./core/types` passed for `geth-control-002`.

Recommended compact locked subset for the next A/B smoke:

- `geth-case-002` — strongest current bug discriminator.
- `geth-case-004` — provider-reviewed nil/null API contract bug.
- `geth-control-001` — provider-reviewed comment-only precision control.
- `geth-control-002` — provider-reviewed no-op refactor precision control.

Keep `geth-case-007` excluded from primary gate until leakage mitigation.

## Compact locked-controls run update 2026-06-18

Run: `.pi/eval/bug-forge/runs/geth-locked-controls-gpt55-codex-low-fast-20260617T155426Z`

Raw first-run report:

- plain mean: raw dominated by `geth-case-002` G1-only gold; see `report.md`.
- self-check/workflow both initially scored poorly on `geth-case-002` because current gold only had G1.
- no-issue controls passed cleanly for all arms.

Provider gold review for `geth-case-002` found current one-bug gold incomplete:

- Existing G1 lifecycle/race bug is valid.
- Add G2: `Start()` returns success before journal setup completes and setup errors are swallowed in `loop`.
- Add G3: `Stop()` no longer propagates journal close errors.

Updated gold was provider-approved after expansion. Use `.pi/eval/bug-forge/runs/geth-locked-controls-gpt55-codex-low-fast-20260617T155426Z/gold-reviewed-rescore.md` for interpretation; do not overwrite raw `score.json`.

Gold-reviewed rescore means:

- plain mean: `0.985`
- self-check mean: `0.919`
- workflow mean: `0.919`

Interpretation:

- compact subset is now primarily a precision/no-issue smoke plus `geth-case-002` gold quality check.
- workflow and self-check both caught G2 but missed G1/G3 in this fast partition-only run.
- plain caught G2+G1 and missed G3.
- next useful comparison is a full workflow rerun on `geth-case-002` plus controls, or finding another production discriminator where workflow recall has room to improve.
