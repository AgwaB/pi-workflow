# review-case-y25 author notes

workflow_artifact must only read files inside the workflow run directory.

Holdout intent: Security/path containment review on runtime artifact reads.

This task was generated before running the holdout backtest and must not be used to tune workflow behavior in the same pass.
