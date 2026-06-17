# review-case-d4 author notes

Internal topic: subtler location/dataflow preservation variant.

## Intended bug family

The patch degrades structured line preservation only for fallback evidence parsing. Reviewers that emit explicit `locations` remain unaffected, but common prose evidence such as `src/file.ts:123` no longer yields a structured line number.

## Why this is harder than A1

- It does not empty `locations` outright.
- File-level identity still survives, so the symptom is partial localization loss.
- The reviewer must connect evidence prose parsing, fallback location reconstruction, and downstream report/scorer quality.

## Expected detection

A good review should flag that colon-style file:line citations are common in code review output and are still needed when a reviewer did not emit explicit locations.
