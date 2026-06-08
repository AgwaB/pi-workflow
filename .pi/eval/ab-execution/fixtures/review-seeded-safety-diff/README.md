# review-seeded-safety-diff

Synthetic untrusted patch fixture for A/B review evaluation. The patch is not applied to the repository; arms are asked to review `diff.patch` as a proposed change.

Hidden answer key lives in `.pi/eval/ab-execution/tasks.json` under `review-seeded-safety-diff.answerKey` and is not included in judge prompts.

Seeded issues:
- Removing explicit `PI_WORKFLOW_ROLE=worker` from child launch path.
- Ignoring stage `maxConcurrency` during scheduling.
- Returning the first parsed JSON candidate without checking `requiredKeys`.
