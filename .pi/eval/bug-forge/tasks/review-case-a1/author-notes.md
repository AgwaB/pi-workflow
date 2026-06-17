# review-case-a1 author notes

Internal topic: location/dataflow preservation variant.

## Intended bug family

A proposed patch should reintroduce a data-flow loss where structured file/line location evidence survives upstream analysis but is dropped before the final review report or common answer formatting.

## Why this is a good candidate

- Based on a real failure observed in the 2026-06-15 A/B analysis.
- Objective signal is strong: final output loses file/line references even though upstream artifacts contain them.
- It tests workflow evidence preservation rather than surface syntax.

## Fixture authoring options

Prefer a same-root-cause variant over an exact revert:

1. Common formatter preserves file names but strips line/range fields.
2. Report schema accepts `locations`, but prompt asks to summarize them into prose and loses machine fields.
3. Dedupe/partition keeps `file` but drops `lineEnd`, making range evidence unscorable.

Avoid making the diff name or comments reveal "location-drop" to candidates.

## Repro idea

Run a review fixture where upstream findings have locations and check:
- upstream partition artifacts contain `locations`,
- final candidate output has materially fewer file/line refs,
- objective scorer recall/localization falls.

## Candidate-visible stance

The patch may be correct or incorrect. Candidate must infer the data-flow loss from code/diff/source, not from task naming.
