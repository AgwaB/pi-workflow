# Benchmark validity hygiene

Date: 2026-07-09
Source: OpenAI, "Separating signal from noise in coding evaluations"
(2026-07-08), plus local batched DA eval defects.

## Purpose

Use this protocol before citing benchmark or canary results as model/workflow
quality evidence.

It is about **validity**: whether a task, label, schema, prompt, reducer,
environment, and claim line up so failures and passes mean what we say they mean.
It does not replace statistical evidence such as paired replays or confidence
intervals.

## Blind gold-label protocol

1. Freeze and hash task inputs, tests/oracles, and candidate gold evidence before
   any arm output is shown to labelers.
2. Labelers judge from visible task inputs, tests/oracles, repo evidence, and the
   proposed gold patch/label only.
3. Labelers must not see default/batched/model outputs until after their first
   independent judgment is recorded.
4. Use at least two independent labelers. Use cross-model or human review when a
   label will support adoption claims.
5. Record agreement rate, disagreements, and confidence.
6. Owner adjudicates disagreements and low-confidence rows directly. Do not only
   spot-check agreements.
7. Any label that depends on context available to only one arm is invalid for arm
   comparison unless all arms receive that context.

## Held-out fixture discipline

- Development fixtures and adoption fixtures are separate.
- If prompt, reducer, schema, or gates were tuned against a fixture, that fixture
  is not held out.
- If labels or inputs are changed after seeing arm outputs, the fixture is burned
  for adoption-quality claims and must be replaced.
- Adoption decisions require a held-out fixture with gold-KEEP rows and
  information parity across arms.

## Validator false-rejection measurement

Treat repeated output-validation failures as a benchmark/task validity signal, not
generic model noise. In particular:

- same schema path + same stage + same message repeated across runs suggests
  prompt/schema contradiction;
- demotions and normalization notes can reveal overly strict or misleading
  validators;
- measure before loosening anything.

This repository keeps deterministic fail-closed behavior unless a later PRD
explicitly changes it.

Use `tools/workflow-forensics.mjs` and inspect the
`validationFailureSignatures` output section for repeated first-attempt validation
failures.

## Canary/result validity classification

Every canary or comparison row should carry one of:

- `genuine` — run is valid for treatment/capability comparison.
- `env-broken` — failure dominated by harness/environment/module/credential or
  rate-limit breakage. Exclude from treatment deltas and rerun if needed.
- `queueing` — wall-clock dominated by scheduling/queueing contention. Exclude
  from speed deltas unless queueing is explicitly under test.

Deltas should be computed over `genuine` rows only. Excluded rows remain visible
with evidence and reason.

## Benchmark-audit prompt template

Use a local deep-review-style audit before adoption claims:

```text
Audit this benchmark for validity defects.
Inputs: task prompt, schema, reducer gates, gold labels, fixture rows,
tests/oracles, and any invalid-attempt traces.
Find contradictions between prompt contract, schema, reducer gates, and labels.
Flag labels whose evidence depends on context only one arm receives.
Classify each issue as overly-strict-test, underspecified-prompt,
low-coverage-test, misleading-prompt, environment-broken, queueing, or other.
Cite exact files/rows/schema paths.
Do not decide adoption; produce a validity findings report.
```

Provider-backed execution of this audit is not part of this document. Obtain
explicit approval before paid/model calls.

## Claim hygiene

- Add dated supersession/retraction notes for interim claims when later evidence
  invalidates them.
- Never rewrite archived run outputs to make history look consistent.
- Keep current allowed claim separate from blocked claims.
- Validity evidence and statistical evidence are separate legs. Do not let one
  substitute for the other.
