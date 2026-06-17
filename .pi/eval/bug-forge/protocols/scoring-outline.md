# Scoring Outline

Primary scoring is objective gold-key matching. LLM-as-judge is secondary/audit only.

## Candidate extraction

1. Prefer the candidate's JSON block matching `schema/candidate-findings.schema.json`.
2. If missing/invalid, use a fallback extractor and record `extractionMode: fallback`.
3. If fallback cannot extract reliable findings, mark extraction inconclusive rather than inventing structure.

## Match rules

A candidate finding can match a gold bug only when:
- file matches one accepted gold location,
- line/range overlaps or symbol/evidence quote identifies the same region,
- claim semantically matches the gold bug,
- evidence quote is grounded in the candidate-visible source/diff.

## Metrics

Report at least:
- severity-weighted precision, recall, and F1,
- localization score,
- evidence quote correctness,
- fix quality,
- false-positive count/weight,
- no-issue hallucination penalty,
- extraction mode/confidence.

## Aggregation

Pilot runs should not overfit to a single number. Use the component metrics to rebucket tasks:
- all arms > 0.9: easy/regression bucket,
- all arms < 0.2: too hard or unclear; rewrite/reject,
- plain baseline around 0.5–0.7: primary discriminating candidate.

## Judge role

LLM judge may assess readability/actionability/concision after objective scoring, but it must not decide factual correctness or gold matching.
