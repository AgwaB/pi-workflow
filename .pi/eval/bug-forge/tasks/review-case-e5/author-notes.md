# review-case-e5 author notes

Internal topic: subtler runtime task propagation variant.

## Intended bug family

The final synthesis prompt explicitly depends on the runtime task, but the stage no longer opts into receiving it. Earlier stages still get the runtime task, making the regression less obvious than a compiler-wide opt-in failure.

## Why this is harder than B2

- The compiler implementation remains intact.
- Reviewers/verifiers still receive the runtime task, so the workflow may appear mostly healthy.
- The defect is in the workflow spec contract: a reduce stage prompt promises to use runtime task constraints that are no longer injected.

## Expected detection

A good review should trace `injectRuntimeTask` semantics from the compiler to this `report` reduce stage and note that final reporting can lose user constraints such as answer format, patch scope, or caveats.
