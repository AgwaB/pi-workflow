# A/B Execution Eval

Compare two execution arms (A and B) on the same task, score the final outputs
blindly with an LLM judge, then report blind quality first and hidden operational
metadata second.

Design: [`../../docs/ab-execution-eval-plan.md`](../../docs/ab-execution-eval-plan.md)
Implementation plan: [`../../docs/ab-execution-impl-plan.md`](../../docs/ab-execution-impl-plan.md)

## Files

- `tasks.json` — tasks and their A/B arms.
- `rubric.md` — scoring dimensions and winner derivation.
- `judge-prompt.md` — per-arm blind judge instructions.
- `run.mjs` — runner.
- `results/<timestamp>/` — per-run outputs, blind packages, scores, report.

## Arms

Each arm is `{ "type": "recipe" | "agent", "name": "<name>" }`.

- `recipe` runs `/flow run <name>`.
- `agent` runs `/flow delegate <name> "<task>"`.

`model`/`thinking` default to the current Pi setting and are shared by both arms.
Recipe and agent names must exist in the current environment
(`/flow recipe list`, `/flow agents`).

## Usage

```bash
# Validate config and print the plan without launching anything:
node evals/ab-execution/run.mjs --dry-run

# Run a single task:
node evals/ab-execution/run.mjs --task review-current-diff

# Run all tasks:
node evals/ab-execution/run.mjs

# Override judge model/reasoning (defaults to current Pi setting):
node evals/ab-execution/run.mjs --judge-model <model> --judge-thinking <level>
```

## Scoring

Each arm is scored independently in its own judge session, so the judge never
sees both outputs together and there is no position bias. The winner is derived
from the two independent score means (see `rubric.md`). Pairwise comparison and
reversed-order passes are out of scope for the MVP.
