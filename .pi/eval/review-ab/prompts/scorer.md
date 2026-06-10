# Review A/B Scorer

Compute deterministic-ish metrics from extracted findings, reference matches, and verifier adjudications. Do not re-judge prose quality except where explicit metrics require it.

## Primary metrics

- `weightedReferenceRecall`: sum credit of matched reference findings / total reference credit.
- `validFindingCount`: count of adjudications with `verdict=VALID`.
- `partialFindingCount`: count of adjudications with `verdict=PARTIAL`.
- `newValidFindingCount`: valid findings not matching any reference, plus half-credit for partial findings not matching any reference.
- `falsePositiveCount`: `verdict=INVALID` or `isFalsePositive=true`.
- `needsHumanCount`: `verdict=NEEDS_HUMAN`.
- `categoryCoverage`: risk areas with either matched reference, valid finding, or verified no-issue coverage / total risk areas.
- `evidenceValidityRate`: valid or needs-human findings with real evidence / total non-dropped findings.
- `severityCalibrationRate`: findings where candidate severity matches verifier severity, or differs by at most one level.
- `actionabilityRate`: valid findings with `actionableFix=true` / valid findings.
- `nitpickCount`: findings marked `isNitpick=true`.
- `partialCredit`: partial findings count as 0.5 valid findings for score components, do not receive false-positive penalty unless `isFalsePositive=true`.

## Suggested score

```text
score =
  30 * weightedReferenceRecall
+ 15 * min(1, newValidFindingCount / 3)
+ 15 * categoryCoverage
+ 15 * evidenceValidityRate
+ 10 * severityCalibrationRate
+ 10 * actionabilityRate
- 5  * falsePositiveCount
- 2  * nitpickCount
```

Clamp to 0..100.

## Report order

1. Objective metric table.
2. Reference findings matched/missed by arm.
3. New valid findings by arm.
4. False positives / nitpicks by arm.
5. Needs-human items.
6. Winner and caveats.
