# Benchmark claim supersession addendum

Date: 2026-07-09

This addendum prevents superseded interim benchmark claims from being cited as
current evidence. It does not rewrite historical artifacts.

## Current claim status

Allowed current claim:

- In the bounded canonical v2 pilot, batched-size4 used fewer tokens and lower
  provider-reported cost than default, but quality/adoption remains blocked.

Blocked current claims:

- Batched DA preserves quality.
- Batched DA is ready for default flip.
- "Same quality but faster."
- Failure probes fully prove injection/retry safety.

## Superseded interim claims

- `bs4 best` / batch-size-4 is adoption-ready: superseded. The earlier evidence
  was affected by circular NEEDS_HUMAN rows, zero gold-KEEP recall visibility,
  and N=1 fixture weakness.
- `batched >= default on gold accuracy`: superseded. The gold benchmark had
  information-parity defects and could not measure true KEEP recall.
- Broad `batched slower` from the schema-bug period: superseded as a general
  claim. The string-vs-array prompt/schema contradiction caused retries and
  distorted timing. Current evidence may still report bounded wall-clock results
  for a specific canonical replay, but not as a universal conclusion.
- Any public quality-parity headline from pre-correction artifacts:
  retracted/blocked unless a future held-out, statistically powered evaluation
  supports it.

## Citation rule

When citing benchmark evidence, include:

1. fixture validity status;
2. whether rows are held out or development-tuned;
3. whether labels were blind/adjudicated;
4. whether env-broken/queueing rows were excluded;
5. whether the claim is validity-only, statistical-only, or both.

## Low-thinking follow-up qualification

The later gpt-5.5/low campaign does not unblock any default-readiness or general parity claim.

- `spec-review`: repeated frozen pairs did not preserve final-finding parity and exposed lowercase candidate-id drift in the default single verifier. The exact-id gate failed closed as designed.
- `deep-research`: numeric/pricing pairs had clean verifier integrity and fewer batched tasks, but claim sets were independently generated; repo-local pairs did not exercise verifier fanout.
- `deep-review`: corrected replay remained favorable to batched-size4 on the validity-reviewed fixture, but no fresh human-blind fixture was added.
- Two continuation processes overlapped. Their new deep-research rows are not valid latency-comparison evidence.

Required citation label for these rows: `model=openai-codex/gpt-5.5; thinking=low; workflow/fixture-specific; no default-readiness inference`.
