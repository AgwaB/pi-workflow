# A/B/C Execution Results

This document summarizes the latest local execution evaluation after the recipe-v1 runtime, plain-baseline runner updates, answer-key matcher hardening, and structured JSON retry hardening.

Raw evaluator artifacts live under `.pi/eval/ab-execution/` and are intentionally local-only.

## Evaluation setup

- Runner: `.pi/eval/ab-execution/run.mjs`
- Task config: `.pi/eval/ab-execution/tasks.json`
- Judge rubric: `.pi/eval/ab-execution/rubric.md`
- Model/thinking: `kimi-coding/kimi-for-coding` / `xhigh`
- Prior stitched suite summary: `.pi/eval/ab-execution/runs/suite-20260606T172500Z/report.md`
- Latest Kimi xhigh live run: `.pi/eval/ab-execution/runs/run-20260607T054737Z/report.md`
- Latest Kimi xhigh final rejudge: `.pi/eval/ab-execution/runs/run-20260607T120050Z/report.md`

The runner compares execution arms on the same runtime task:

- recipe arm: `/workflow run <recipe> "<task>"`
- baseline arm: plain single Pi, with no expert/persona wrapper
- research-only comparison arm: generated `parallel5` researcher fanout plus synthesis

Blind judges score anonymized final outputs independently. Hidden metadata and answer-key coverage are revealed only after blind scoring.

## Latest suite summary

These results combine individual Kimi xhigh runs after structured-output retry hardening. They are not from one atomic all-task runner invocation; expensive/completed tasks were reused or rejudged.

| Task | Recipe arm | Baseline arm(s) | Result | Evidence |
|---|---|---|---|---|
| `research-agent-evals` | `deep-research` | `plain`, `parallel5` | Top tie: `deep-research` and `parallel5` both 4.83; `plain` 4.50 | `.pi/eval/ab-execution/runs/run-20260606T123421Z` |
| `review-seeded-safety-diff` | `deep-review` | `plain` | Blind tie 4.83/4.83; answer-key tie 3/3 vs 3/3 after matcher rejudge | `.pi/eval/ab-execution/runs/run-20260606T171918Z` |
| `migration-plan` | `migration` | `plain` | Blind tie 4.17/4.17; recipe completed after one JSON retry | `.pi/eval/ab-execution/runs/run-20260606T153223Z` |
| `decision-microservices-monolith` | `decision-debate` | `plain` | `plain` won: 4.83 vs `decision-debate` 4.17 | `.pi/eval/ab-execution/runs/run-20260606T160208Z` |
| `revise-json-extraction-proposal` | `revise-loop` | `plain` | `revise-loop` won: 3.83 vs 3.50 | `.pi/eval/ab-execution/runs/run-20260606T161124Z` |

## Interpretation

- `deep-research`: competitive with naive `parallel5`; both beat plain by blind score.
- `deep-review`: seeded objective coverage passed after answer-key matcher broadened to catch valid paraphrases.
- `migration`: runtime JSON retry hardening fixed the Kimi structured-output failure mode; quality tied plain.
- `decision-debate`: under this prompt/model, plain outperformed the debate workflow. Treat this as a recipe/test follow-up before using `decision-debate` as positive release evidence.
- `revise-loop`: modest blind win over plain on a code-oriented revision proposal.

## Validation context

Safe validation after runner/runtime hardening:

```bash
npm test
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --self-test
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --dry-run
git diff --check
```

Results:

- `npm test`: 35/35 passed.
- Runner self-test: passed.
- Eval dry-run: passed.
- `git diff --check`: passed.

## Follow-ups

1. Decide whether `decision-debate` needs recipe prompt/structure hardening or a better scenario before using it as release evidence.
2. Consider a single clean full-suite run after all runner/answer-key changes, if cost/time are acceptable.
3. Keep human spot-check for research/revision coverage criteria; they are not machine-gated.
