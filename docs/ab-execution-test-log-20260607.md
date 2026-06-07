# A/B/C Execution Test Log — 2026-06-07

This document records the test process, run history, results, and interpretation for the latest local A/B/C evaluation hardening work.

The purpose is evidence hygiene: preserve what was actually run, what failed, what was fixed, and what can or cannot be claimed from the results.

## 1. Scope

Evaluated the local pi-workflow A/B/C runner under the hardened scoring path.

Primary runner/config files:

- `.pi/eval/ab-execution/run.mjs`
- `.pi/eval/ab-execution/tasks.json`
- `.pi/eval/ab-execution/rubric.md`
- `.pi/eval/ab-execution/judge-prompt.md`

Primary result artifacts:

- Claude attempt: `.pi/eval/ab-execution/runs/run-20260607T024842Z/report.md`
- Kimi live run: `.pi/eval/ab-execution/runs/run-20260607T054737Z/report.md`
- Kimi final rejudge: `.pi/eval/ab-execution/runs/run-20260607T120050Z/report.md`

The final result to cite for the latest Kimi xhigh evidence is:

```text
.pi/eval/ab-execution/runs/run-20260607T120050Z/report.md
```

## 2. Runner behavior validated before live runs

The runner was hardened so it does not turn operational failures into false wins.

Validated behaviors:

- Workflow arms are scoreable only when the workflow run is terminal successful (`completed`) and all tasks completed.
- Running, failed, blocked, partial, and empty-output workflow arms become deterministic `failed-to-complete` and are not sent to the judge.
- Failed plain/direct Pi arms become deterministic `failed-to-complete`.
- Non-scoreable arms cannot beat scoreable arms.
- All non-scoreable arms tie rather than producing a misleading winner.
- Judge infrastructure failure is separated from candidate failure:
  - `scores: null`
  - `hardFailures: []`
  - `judgeError.reason` records the judge failure
  - winner becomes `unscored`
- Judge failure is not reported as candidate `invalid-output`.

Validation commands run after the latest judge-failure fix:

```bash
node --check .pi/eval/ab-execution/run.mjs
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --self-test
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --dry-run
npm test
git diff --check
```

Observed results:

- Runner self-test passed, including judge-unavailable and `unscored` report behavior.
- Dry-run resolved all configured arms.
- `npm test` passed: 35/35.
- `git diff --check` passed.

## 3. Chronological run history

### 3.1 Claude model selection

Requested model:

```text
claude-haiku-4-5 / xhigh
```

Pi model registry did not contain `claude-haiku-4-5`. Available Claude models were:

```text
anthropic/claude-opus-4-5
anthropic/claude-opus-4-7
anthropic/claude-opus-4-8
anthropic/claude-sonnet-4-5
anthropic/claude-sonnet-4-6
```

Selected replacement:

```text
anthropic/claude-sonnet-4-6 / xhigh
```

### 3.2 Claude Sonnet 4.6 run

Command:

```bash
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs \
  --model anthropic/claude-sonnet-4-6 \
  --thinking xhigh \
  --judge-model anthropic/claude-sonnet-4-6 \
  --judge-thinking xhigh
```

Runner process:

```text
.pi/agent/runs/run_mq36nhk2_b0d46c/task-1/output.log
```

Result path:

```text
.pi/eval/ab-execution/runs/run-20260607T024842Z/report.md
```

Outcome:

- Not usable as quality evidence.
- Plain single-Pi arms failed with Claude quota/usage errors:

```text
400 invalid_request_error: You're out of extra usage.
```

- Judge calls failed with Claude rate-limit/quota conditions:

```text
HTTP 429 rate_limit_error
This request would exceed your account's rate limit.
```

Diagnostic finding:

- The runner was still classifying judge parse/failure as candidate `invalid-output`.
- That was measurement contamination: judge infrastructure failure is not candidate output failure.

Follow-up fix:

- Judge failure now produces `scores: null` and `judgeError`, with winner `unscored`.
- Candidate hard failures are not polluted by judge infrastructure failures.

### 3.3 Kimi xhigh live suite

Command:

```bash
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs \
  --model kimi-coding/kimi-for-coding \
  --thinking xhigh \
  --judge-model kimi-coding/kimi-for-coding \
  --judge-thinking xhigh
```

Runner process:

```text
.pi/agent/runs/run_mq3d1kmw_ce7d5b/task-1/output.log
```

Initial result path:

```text
.pi/eval/ab-execution/runs/run-20260607T054737Z/report.md
```

Initial observed summary:

| Task | Initial winner | Notes |
|---|---|---|
| `research-agent-evals` | blind A | all arms scoreable |
| `review-seeded-safety-diff` | blind A | answer-key tie |
| `migration-plan` | blind B | all arms scoreable |
| `decision-microservices-monolith` | blind A | all arms scoreable |
| `revise-json-extraction-proposal` | blind A | workflow arm was still `running` at runner wait boundary and was correctly non-scoreable |

Important event:

- `revise-loop` workflow was still running when the runner evaluated it:

```text
workflow_mq3ftpxp_31443e
status: running
reason: workflow status is running; pending/running tasks; final output empty
```

- The hardened runner correctly treated that arm as `failed-to-complete` rather than scoring partial output.
- The workflow later completed successfully after additional waiting.

Manual waits used to confirm completion:

```bash
PI_WORKFLOW_ROLE=supervisor pi --offline --no-session --no-context-files \
  --no-skills --no-prompt-templates --no-themes --no-extensions --extension . \
  --print '/workflow wait workflow_mq3ftpxp_31443e 600000'

PI_WORKFLOW_ROLE=supervisor pi --offline --no-session --no-context-files \
  --no-skills --no-prompt-templates --no-themes --no-extensions --extension . \
  --print '/workflow wait workflow_mq3ftpxp_31443e 900000'
```

Final wait result:

```text
workflow_mq3ftpxp_31443e [completed]
tasks=5/5 completed
```

### 3.4 Rejudge after `revise-loop` completed

Purpose:

- Re-extract workflow outputs from the same live run artifacts.
- Re-score after `workflow_mq3ftpxp_31443e` reached completed status.
- Do not relaunch arms.

Command:

```bash
PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs \
  --rejudge .pi/eval/ab-execution/runs/run-20260607T054737Z \
  --judge-model kimi-coding/kimi-for-coding \
  --judge-thinking xhigh
```

First rejudge process:

```text
.pi/agent/runs/run_mq3hgaff_56e0c2/task-1/output.log
```

Intermediate result path:

```text
.pi/eval/ab-execution/runs/run-20260607T075102Z
```

Outcome:

- Scoring completed, but report generation hit a runner bug when a task winner was `unscored`:

```text
Cannot read properties of undefined (reading 'type')
```

Fix:

- Report rendering now treats `unscored` as a report-level outcome, not a configured arm key.
- Self-test added: `unscored winner is not treated as configured arm`.

Final rejudge process:

```text
.pi/agent/runs/run_mq3qdj55_72be04/task-1/output.log
```

Final rejudge result path:

```text
.pi/eval/ab-execution/runs/run-20260607T120050Z/report.md
```

## 4. Final Kimi xhigh result

Use this report for the final latest result:

```text
.pi/eval/ab-execution/runs/run-20260607T120050Z/report.md
```

### 4.1 Raw final report summary

| Task | Blind winner | Blind scores / hard failures |
|---|---|---|
| `research-agent-evals` | blind A | A 5.00, B 4.83, C 4.83; no hard failures |
| `review-seeded-safety-diff` | blind A | A 5.00, B 4.50; B had `hallucinated-file-path` |
| `migration-plan` | blind B | A 4.50, B 5.00; no hard failures |
| `decision-microservices-monolith` | blind A | A 5.00, B 4.67; no hard failures |
| `revise-json-extraction-proposal` | blind A | A 4.50, B 3.33; B had `unsupported-critical-claim` |

### 4.2 Mapping-revealed final result

| Task | Configured winner | Workflow arm | Plain / other arm | Interpretation |
|---|---|---|---|---|
| `research-agent-evals` | **plain single Pi** | `deep-research`: 4.83 | `plain`: 5.00; `parallel5`: 4.83 | Plain won by judge score. Human spot-check still required for research coverage. |
| `review-seeded-safety-diff` | **plain single Pi** | `deep-review`: 4.50, `hallucinated-file-path` | `plain`: 5.00 | Blind judge favored plain. Hidden answer-key was tie: both found 3/3 seeded issues. Treat objective seeded coverage as tie. |
| `migration-plan` | **plain single Pi** | `migration`: 4.50 | `plain`: 5.00 | Plain produced the stronger judged migration plan in this run. |
| `decision-microservices-monolith` | **plain single Pi** | `decision-debate`: 4.67 | `plain`: 5.00 | Plain again won; `decision-debate` remains weak evidence. |
| `revise-json-extraction-proposal` | **`revise-loop` workflow** | `revise-loop`: 4.50 | `plain`: 3.33, `unsupported-critical-claim` | Workflow won after the workflow completed and was rejudged. |

### 4.3 Aggregate view

Configured winners:

```text
plain single Pi: 4/5
workflow: 1/5
parallel5: 0/1 research comparison
```

Important nuance:

- `review-seeded-safety-diff` is a blind-score win for plain but objective answer-key tie.
- `research-agent-evals` and `revise-json-extraction-proposal` include coverage criteria that still require human spot-check.
- The final `revise-loop` score comes from rejudge after the original live workflow completed later than the runner wait boundary.

## 5. Interpretation

This latest Kimi xhigh run does **not** support a broad claim that pi-workworkflows outperform plain single Pi.

More accurate conclusions:

- The hardened evaluation harness is now substantially more credible:
  - non-terminal outputs are not scored,
  - judge failures are separated as `unscored`,
  - hard failures and scoreability are explicit in reports.
- Kimi xhigh plain single Pi is a very strong baseline.
- Current workflow evidence is mixed:
  - `revise-loop` showed value after full completion,
  - `deep-review` tied objective seeded coverage but lost blind score,
  - `deep-research`, `migration`, and `decision-debate` lost to plain in the final Kimi rejudge.
- `decision-debate` should not be used as positive release evidence without workflow redesign and a better scenario or acceptance rubric.

## 6. Claims allowed / not allowed

Allowed:

```text
The A/B/C eval runner now records and separates operational failures, non-terminal outputs, judge failures, and scoreable outputs more honestly.
```

```text
In the latest Kimi xhigh diagnostic suite, plain single Pi won most judged tasks, while revise-loop won the JSON extraction proposal task after successful completion.
```

Not allowed:

```text
pi-workflow generally beats plain Pi.
```

```text
The latest results are universal release-grade superiority evidence.
```

```text
The Claude Sonnet run is a valid quality comparison.
```

## 7. Panel review

A four-reviewer panel reviewed the evaluation purpose, direction, method, actual setup/process/results, and workflow improvement priorities.

Panel review document:

```text
docs/ab-execution-panel-review-20260607.md
```

Source review run:

```text
.pi/skill-runs/review/run_20260607_124849_f55ee664
```

Panel verdict:

```text
needs-eval-fix + needs-workflow-fix
```

Most important panel findings:

- `research-agent-evals` winner is a tie-threshold/floating edge and should be treated as near-tie/uncertain.
- The normalizer rewrites real `ab-execution` fixture paths to `<eval-spec>`, likely contaminating the `review-seeded-safety-diff` blind score.
- Latest evidence remains diagnostic: n=1, single judge, same execution/judge model, no human spot-check.
- Workflow weaknesses are still real, especially `decision-debate`, `deep-research`, and `migration`.

## 8. Follow-ups

1. Fix tie-threshold and normalizer issues, then rejudge existing Kimi artifacts.
2. Human spot-check `research-agent-evals` and `revise-json-extraction-proposal` against their coverage criteria before citing them externally.
3. Keep seeded answer-key coverage as the primary signal for `review-seeded-safety-diff`; blind score alone is not enough.
4. Consider shorter or more bounded `revise-loop` timeouts/prompts if live suite runtime matters.
5. Redesign or narrow `decision-debate` before using it as release evidence.
6. If future judge calls time out on large outputs, consider a bounded judge-input excerpt/summary strategy, but record that as a measurement change.
