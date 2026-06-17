# Bug-forge reproducibility notes

## Source revision

Bug-forge tasks are pinned to:

- `a48c12a899447309b0adbb200d014c88cca61c8c`

During follow-up work this object was missing from the local git object database. It was restored with:

```bash
git fetch origin a48c12a899447309b0adbb200d014c88cca61c8c
```

Validation after restore:

```bash
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-j10 --out .tmp/bug-forge-materialize-check/j10
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-m13 --out .tmp/bug-forge-materialize-check/m13
```

Both completed with no forbidden hits.

## Calibration adapter

`.pi/eval/bug-forge/scripts/calibrate.mjs` is currently ignored by git in this repository. Local fixes made during root-merge A/B:

- Added `--workflow-extension-root` / `--workflow-ref` support so candidate workspaces can be scored with the current workflow spec instead of the pinned candidate copy.
- Fixed workflow control normalization to extract nested quote evidence.
- Combined direct `finding.evidence`, direct `finding.evidenceQuote`, and control-level nested evidence quotes into candidate `evidenceQuote` before digest fallback.

Why this matters:

- D4 reports may put required evidence under nested `evidenceIndex.repositoryEvidence[].quote`.
- M13 reports may put fixture/proposed-diff evidence in `finding.evidenceQuote` while control-level evidence cites current source.
- Keeping all relevant quote strings avoids false scoring failures caused by adapter evidence selection.

If the benchmark runner must be reproducible across machines, promote these changes into a tracked eval runner or force-add the relevant `.pi/eval/bug-forge` files intentionally.

## J10/M13 lock state

J10 and M13 are now marked locked in ignored bug-forge artifacts after:

- explicit RED/GREEN repro scripts,
- final Kimi low review approval,
- `node .pi/eval/bug-forge/scripts/validate.mjs` passing.

Because `.pi/` is ignored, these status changes are local unless intentionally force-added.

## Untracked README assets

The following untracked files were present during cleanup and are unrelated to this bug-forge/spec-review work:

- `docs/assets/readme/impact-review-flow.png`
- `docs/assets/readme/spec-review-flow.png`

They are currently unreferenced by README/docs/package manifests and were left untouched.
