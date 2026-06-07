# A/B Execution Test Strategy

This document explains how the local A/B execution evaluation is validated and which tests are prepared. It intentionally excludes performance, cost, and latency measurement.

## 1. Test method

A/B evaluation compares execution strategies on the same task. Most tasks use two arms, but research can use three arms when the middle strategy is important.

Example:

```text
A = workworkflow, such as deep-review or deep-research
B = plain single Pi run, with no expert agent/persona wrapper
C = naive parallel-5 research, for research tasks only
```

All arms receive the same task text. The runner then evaluates them in two layers.

### Layer 1 — blind output quality

Purpose: answer "which final answer is better for the user?"

Process:

1. Run all configured arms on the same task.
2. Extract each arm's final user-facing output.
3. Normalize outputs to remove run ids, workflow artifact paths, explicit arm labels, generated eval spec names, and structural markdown heading markers that can fingerprint JSON workflow outputs.
4. Randomize blind labels so the judge sees only anonymized `output-<label>.md` files.
5. Score each output independently with the rubric in `.pi/eval/ab-execution/rubric.md`.
6. Derive a blind winner from independent scores and hard-failure flags; small mean differences at or below one rubric point across one dimension are treated as ties.

The blind judge must not see workflow names, agent names, task counts, run ids, stage names, logs, or operational metadata.

### Layer 2 — hidden answer-key check for seeded tasks

Purpose: answer "did the output catch the issues we intentionally planted?"

Some tests include a hidden `answerKey`. This is a machine-checkable checklist of expected findings. It is not passed to either arm and is not shown to the blind judge.

For each known issue, the runner first removes fenced code blocks and unified-diff quote lines from the matcher input while preserving ordinary Markdown bullets. It then checks whether one configured evidence term set appears within a bounded window, co-occurs with a distinct defect marker such as `missing`, `removed`, `ignored`, `bypass`, `unsafe`, or `regression`, and is not obviously negated. The result is written under:

```text
.pi/eval/ab-execution/runs/<timestamp>/internal/<task-id>/answer-key-results.json
```

Seeded task interpretation:

- Missing a configured critical/major seeded issue can be marked as a hard objective miss.
- Answer-key coverage is reported after blind scoring, in the hidden/objective section.
- For seeded review tasks, answer-key coverage is more important than a small blind-score difference.

Known limits:

- The checker is deterministic and intentionally simple; it is not a full semantic proof that a reviewer understood the issue.
- The quote stripping, proximity window, and defect-marker requirement are designed to reject obvious false positives such as verbatim patch quotation or "no concern" affirmations.
- Borderline cases may still need human spot-checking before treating a result as release evidence.

### Reproducibility controls

Each run writes a manifest with:

- git commit and dirty status,
- runner/task/rubric/judge prompt hashes,
- workflow/agent file paths and hashes,
- execution model/thinking and judge model/thinking settings, with ambient defaults recorded as `default-unresolved` when the runner cannot resolve them,
- fixture paths and hashes,
- answer-key presence,
- Pi version, Node version, platform, and architecture.

This lets a result be interpreted as evidence rather than a one-off anecdote.

## 2. Prepared tests

The local task list lives in:

```text
.pi/eval/ab-execution/tasks.json
```

### `research-agent-evals`

Comparison:

```text
A: workflow deep-research
B: plain single Pi
C: naive parallel-5 research with researcher subagents and final synthesis
```

Task: research current best practices for evaluating AI coding-agent workflows against single-agent baselines.

What it tests:

- external source discovery,
- source quality and citation discipline,
- coverage of blind evaluation, seeded defects, contamination, LLM-as-judge reliability, reproducibility, and cost/quality tradeoffs,
- whether deep-research adds value over both a plain single run and a simple parallel fanout.

Primary validation: blind output quality plus human spot-check against the coverage criteria in `tasks.json`. This is not an answer-key hard gate because external research has no fixed ground truth.

### `review-seeded-safety-diff`

Comparison:

```text
A: workflow deep-review
B: plain single Pi
```

Task: review a synthetic patch fixture:

```text
.pi/eval/ab-execution/fixtures/review-seeded-safety-diff/diff.patch
```

What it tests:

- objective defect detection,
- safety review depth,
- ability to find known critical/major regressions,
- false-confidence resistance.

Hidden answer-key issues:

1. Child workers are launched without explicit `PI_WORKFLOW_ROLE=worker`.
2. Scheduler ignores `maxConcurrency` and may launch all pending tasks.
3. Structured JSON parsing returns the first JSON candidate without checking `requiredKeys`.

Primary validation: hidden answer-key coverage, then blind output quality. All three seeded issues are configured as hard objective misses if not found.

### `migration-plan`

Comparison:

```text
A: workflow migration
B: plain single Pi
```

Task: plan an explicit headless execution backend while preserving local-pi/tmux behavior.

What it tests:

- planning structure,
- risk sequencing,
- compatibility analysis,
- implementation-path clarity.

Primary validation: blind output quality.

### `decision-microservices-monolith`

Comparison:

```text
A: workflow decision-debate
B: plain single Pi
```

Task: decide whether a 35-person B2B SaaS team should split a modular monolith into microservices now or continue with the modular monolith for 12 months.

What it tests:

- multi-perspective decision quality,
- ability to avoid generic “it depends” answers,
- treatment of ownership, data consistency, SRE capacity, CI/CD, observability, incident response, and rollback,
- dissenting-argument strength,
- recommendation clarity and calibration.

Primary validation: blind output quality plus human spot-check for scenario-specific reasoning.

### `revise-json-extraction-proposal`

Comparison:

```text
A: workflow revise-loop
B: plain single Pi
```

Task: produce a small, testable implementation proposal for tolerant JSON extraction in an AI workflow runner.

What it tests:

- iterative critique/revision value on code-oriented output,
- edge-case coverage for raw/fenced/prose/multiple JSON candidates,
- requiredKeys candidate selection,
- string/escape-aware balanced scanning,
- realistic unit test planning,
- avoidance of regex-only or prompt-only parsing assumptions.

Primary validation: blind output quality plus checklist coverage in `coverageCriteria`.

Recommended first live A/B run:

```bash
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --task review-seeded-safety-diff
```

## Minimum useful validation sequence

Before any live A/B run:

```bash
node --check .pi/eval/ab-execution/run.mjs
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --dry-run
```

Then run the seeded test first:

```bash
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --task review-seeded-safety-diff
```

Only after the seeded test behaves sensibly should the broader subjective tasks be run.

## Non-goals

- Performance benchmarking.
- Provider cost accounting.
- Board UX study.
- Multi-judge calibration.
- Pairwise/reversed-order judging.
- Applying seeded fixtures to the actual repository.
