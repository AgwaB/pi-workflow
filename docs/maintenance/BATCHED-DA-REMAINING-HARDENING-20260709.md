# Batched DA remaining hardening — 2026-07-09

## Status

Adoption remains blocked, but the post-hardening evidence improved.

## What changed

- `tools/workflow-forensics.mjs` now classifies repeated validation-failure signatures with:
  - `triageCategory`
  - `benchmarkValiditySignal`
  - `recommendedAction`
- `workflows/deep-review/batched-devil-advocate.spec.json` now explicitly
  tells batched DA workers that the root control `schema` must be exactly
  `deep-review-devil-advocate-batch-v2` and must not be the controlSchema file
  path, a relative schema path, or an older v1 schema string.
- `workflows/deep-review/helpers/finding-pipeline.mjs` now matches
  single-finding DA verdicts by exact reviewer `findingId` echo before falling
  back to title/token matching.
- Focused tests cover workflow-forensics triage, the batched prompt guard, and
  exact `findingId` echo partitioning.

## Evidence summary

### Repeated validation signatures

Latest accessible analysis-corpus scan:

- 345 runs scanned
- 234 validation-failure signatures
- 141 repeated signatures
- Categories:
  - schema-shape mismatch: 152
  - underspecified required field: 53
  - triage-needed: 22
  - over-strict output limit: 7

These are triage signals, not automatic proof that a benchmark task is invalid.

### Txpool

`txpool-chain` remains excluded from adoption recall evidence. Prior rows are
contradicted by current row-local snippets and should not be treated as
true-KEEP adoption truth without independent re-adjudication against the
intended buggy revision.

### Retry hardening

Prior batched replay had 7 invalid attempts, all in the batched arm, all with
`$.schema` enum failures. The hardening preserves fail-closed validation and
only clarifies the required schema literal.

### Validity-reviewed replay

Post-hardening replay on `fork-storage-validity-reviewed`:

- 10/10 provider-backed runs completed
- 20 model-backed cells
- provider-reported cost `$2.992567`
- original default strict/partial recall was scored as `0 / 0`, but this was a
  deterministic partition-join artifact: the single-finding DA workers echoed
  finding IDs while the partition helper only matched single-finding verdicts by
  title/token overlap.
- after local correction, default strict/partial recall is `0.667 / 0.667`.
- batched-size4 strict/partial recall is `0.667 / 0.667`.
- batched-size4 invalid attempts: `0`.
- batched-size4 saved tokens/cost in every pair.
- batched-size4 was faster in 4/5 pairs.

This is promising but not adoption-grade because the fixture is
validity-reviewed rather than fresh human-blind, the source status is draft, and
the corrected result shows candidate-specific parity rather than adoption-grade
general quality evidence.

## Allowed claim

On the validity-reviewed fork-storage candidate after schema prompt hardening
and corrected default partition scoring, batched-size4 completed 5/5 runs with
zero invalid attempts, lower tokens/cost, faster wall-clock in 4/5 pairs, and
recall parity with the default arm.

## Forbidden claims

Do not claim:

- batched DA preserves quality generally;
- batched DA is ready for default flip;
- same quality but faster generally;
- txpool true-KEEP recall is fixed;
- a fresh held-out benchmark has passed.

## External-dependency handoff

The remaining adoption blockers are not locally completable without new
independent evidence:

1. **Fresh human-blind fixture creation:** an independent human adjudicator must
   label a held-out fixture set without seeing the candidate/default outputs.
   Self-authored labels from this maintenance session would not be human-blind
   adoption evidence.
2. **Txpool replacement/re-adjudication:** `txpool-chain` needs the intended
   buggy revision and independent truth review before it can contribute to
   recall. Until then it remains excluded.
3. **Adoption replay:** after the two items above exist, run a larger blinded
   paired eval under explicit provider caps and report provider-reported cost
   only.

## Next recommended work

1. Obtain the fresh human-blind fixture set.
2. Keep the default partition identity-join correction covered; any future
   replay should score exact findingId echoes correctly.
3. Keep txpool excluded until independently re-adjudicated.
4. If pursuing adoption, rerun a larger blinded eval after fresh human-blind
   fixture creation.

## Low-thinking repetition update

A later three-pair replay used `openai-codex/gpt-5.5` with thinking `low` on the same validity-reviewed fixture:

- 6/6 runs completed;
- strict recall mean `0.4444` default vs `0.6667` batched-size4;
- DA tasks `9 -> 3`;
- provider-reported cost `$2.390353 -> $1.150739`;
- invalid attempts `0 / 0`;
- quality-regression pairs `0`.

This does not change adoption status. It is the same fixture family, not fresh human-blind evidence, and the default arm changed across thinking regimes. Cite it only as fixture- and regime-specific opt-in evidence.

## Commit-ready message

`fix: harden batched review evidence scoring`
