# review-case-b2 author notes

Internal topic: runtime task / stale-context propagation variant.

## Intended bug family

A proposed patch should prevent cross-cutting user constraints from reaching model stages that reason about the patch (for example reviewers, verifiers, or reduce stages). The bug should cause those stages to fall back to current HEAD assumptions or miss patch-specific constraints.

## Why this is a good candidate

- Based on a real workflow defect fixed during A/B diagnosis.
- It tests whether reviewers understand stage kind/context propagation rather than just local syntax.
- Observable effects include stale HEAD drift, false dismissals, and missing findings.

## Fixture authoring options

Prefer a variant over exact revert:

1. Keep `injectRuntimeTask` validation but accidentally ignore it for `foreach` children.
2. Inject only into `report`, not reviewer/verifier stages where the constraint matters.
3. Gate runtime task injection on the wrong stage property so some reduce/foreach stages silently miss it.

Avoid comments or filenames that reveal the root cause to candidates.

## Repro idea

Use a diff-review task whose prompt says to evaluate the patch on its own terms. Verify:
- reviewer/verifier task prompts do not include the runtime task constraint,
- outputs mention HEAD mismatch / moved symbols / cannot verify from current code,
- answer-key recall or calibration falls.

## Candidate-visible stance

The candidate sees only a proposed patch and sanitized repo. It must identify that the patch breaks propagation of runtime review constraints, not that a known historical bug was reintroduced.
