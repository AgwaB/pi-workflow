# A/B/C Execution Panel Review — 2026-06-07

This document records the four-reviewer panel review of the pi-workflow A/B/C evaluation. It is a review of the evaluation purpose, direction, method, setup/process/results, and workflow recipe improvement priorities.

## Source artifacts

Standalone review run:

```text
.pi/skill-runs/review/run_20260607_124849_f55ee664
```

Panel synthesis:

```text
.pi/skill-runs/review/run_20260607_124849_f55ee664/files/review-report.md
.pi/skill-runs/review/run_20260607_124849_f55ee664/files/findings.json
```

Reviewer outputs:

```text
.pi/skill-runs/review/run_20260607_124849_f55ee664/files/reviewers/opus-max.md
.pi/skill-runs/review/run_20260607_124849_f55ee664/files/reviewers/kimi-xhigh.md
.pi/skill-runs/review/run_20260607_124849_f55ee664/files/reviewers/gpt-5.5.md
.pi/skill-runs/review/run_20260607_124849_f55ee664/files/reviewers/agy-default.md
```

Reviewed evaluation artifacts:

```text
docs/ab-execution-test-log-20260607.md
docs/ab-execution-results.md
docs/ab-execution-test-strategy.md
.pi/eval/ab-execution/run.mjs
.pi/eval/ab-execution/tasks.json
.pi/eval/ab-execution/rubric.md
.pi/eval/ab-execution/judge-prompt.md
.pi/eval/ab-execution/runs/run-20260607T120050Z/report.md
```

## Review panel

| Reviewer | Runtime |
|---|---|
| Opus max | `anthropic/claude-opus-4-8` / `xhigh` |
| Kimi | `kimi-coding/kimi-for-coding` / `xhigh` |
| GPT-5.5 | `openai-codex/gpt-5.5` / `xhigh` |
| agy | `agy` default |

## Synthesis verdict

```text
needs-eval-fix + needs-workflow-fix
```

The panel agreed on two points:

1. The runner is now much more credible as a diagnostic harness after terminal gating, judge-failure separation, and scoreability reporting.
2. The latest Kimi result still should not be treated as release-grade superiority evidence. There are remaining measurement bugs and several recipes are not sharp enough against a strong plain Kimi baseline.

## Highest-priority findings

### 1. Research task winner is a tie-threshold edge

The final Kimi report marks `research-agent-evals` as a plain single-Pi win. The margin is effectively one rubric point across one dimension:

```text
plain: 5.00
deep-research: 4.83
parallel5: 4.83
tieThreshold: 0.16666666666666666
diff: 0.16666666666666696
```

Panel interpretation:

- This is a floating-point/tie-threshold edge, not strong evidence of a meaningful win.
- Treat `research-agent-evals` as near-tie/uncertain until the artifacts are rejudged with the corrected tie logic.

### 2. Normalizer contaminates real fixture paths

The runner's normalization redacts generated `ab-*` names, but it also rewrites real repository paths containing `ab-execution`:

```text
.pi/eval/ab-execution/...
→ .pi/eval/<eval-spec>/...
```

Observed in final blind review outputs:

```text
.pi/eval/<eval-spec>/fixtures/review-seeded-safety-diff/diff.patch
```

Panel interpretation:

- The `hallucinated-file-path` hard failure in `review-seeded-safety-diff` was likely measurement contamination.
- For that task, hidden answer-key coverage is the more trustworthy signal: both arms found 3/3 seeded issues. Rejudge is still required after the path-normalizer fix.

### 3. Current evidence is single-run, single-judge, same-model

The latest result uses Kimi execution and Kimi judge. That is useful diagnostic evidence, but not release-grade comparative evidence.

Missing before stronger claims:

- repeat runs / variance,
- cross-model judge,
- human spot-check artifacts,
- robust tie handling,
- confidence intervals or repeated judge passes.

### 4. Cost, latency, and orchestration size are not first-class metrics

Workflow arms can run many more tasks than plain Pi. Example:

```text
deep-research: 58 tasks
plain: 1 task
```

Panel interpretation:

- Tying or slightly losing with 58 tasks is poor product ROI.
- Reports should expose task count, latency, and cost/effort as interpretation context.

### 5. Recipe weakness is real, even after measurement caveats

The panel did not attribute all poor workflow results to test flaws. Several recipes appear weak or over-structured:

- `decision-debate`: repeated weak evidence; likely stage dependency/final schema issues.
- `deep-research`: too much fanout for unclear gain.
- `migration`: likely over-structures inventory/item planning without improving final plan.
- `deep-review`: objective coverage tied plain; current fixture is too easy for Kimi xhigh.
- `revise-loop`: strongest positive signal, but completion budget/timeout must be made explicit.

## Revised interpretation of the Kimi result

Do **not** summarize the latest result as a clean `plain 4/5` release-grade win.

Safer interpretation:

```text
plain clear wins: migration, decision
workflow clear win: revise-loop
review seeded fixture: objective tie, blind score contaminated
research: near-tie / uncertain due threshold edge
```

This still does not support workflow superiority. It also does not prove plain is categorically better.

## Answers to the review questions

### 1. Test purpose

Current purpose is good for diagnostic evidence hygiene: record what ran, what failed, what was scoreable, and what claims are unsafe.

Better pre-release purpose:

```text
Identify which task classes justify recipe orchestration over strong plain Pi, under what budget/time constraints, and with what evidence.
```

### 2. Test direction

Move away from universal workflow-vs-plain claims. Use conditional recipe claims:

- `revise-loop` for iterative critique/revision tasks.
- `deep-review` for hard seeded defect detection, not generic prose quality.
- `deep-research` only if it proves source/citation coverage beyond plain/parallel.
- `decision-debate` only after redesign and a better dissent-quality rubric.

### 3. Test method

Strong parts:

- same task text,
- plain baseline without specialist wrapper,
- blind labels,
- hidden answer key for seeded review,
- terminal gating,
- judge failure separation.

Needs fixes:

- tie threshold/equality handling,
- normalizer path contamination,
- same-model judge bias,
- n=1 sampling,
- missing human spot-check,
- missing cost/latency/ROI,
- possible output-shape/concision bias.

### 4. Setup/process/results documentation

Documentation is strong: commands, failed Claude run, Kimi live/rejudge flow, and caveats are recorded.

Still missing:

- raw judge attempts in report or artifact index,
- dimension-level score tables in summary,
- human spot-check outputs,
- clean commit/diff snapshot,
- Pi version capture,
- cost/latency/token estimates.

### 5. Weak tests or weak workflows?

Panel consensus: both.

Likely cause ranking:

1. eval/method issues: tie threshold, normalizer, n=1, same-model judge;
2. strong Kimi xhigh plain baseline;
3. recipe/task mismatch;
4. actual recipe weaknesses, especially `decision-debate`, `deep-research`, `migration`;
5. insufficient fixture power for `deep-review`.

### 6. Workflow recipe improvement priorities

- `decision-debate`: fix frame-to-positions data flow; require strongest dissent and changed-conditions in final output; consider reducing 3-way debate if it only adds verbosity.
- `deep-research`: hard-cap fanout; make verification selective; report source-quality/citation table; reduce default depth.
- `migration`: cap inventory/item planning; focus on critical path and staged executable plan.
- `deep-review`: improve final report concision and severity preservation; strengthen fixture before heavy recipe changes.
- `revise-loop`: keep structure, but bound timeout and make completion budget explicit.

## Safe and unsafe claims

Safe:

```text
The A/B/C runner now separates non-terminal outputs, judge failures, and candidate failures more honestly.
```

```text
The latest Kimi xhigh diagnostic suite does not prove general workflow superiority.
```

```text
revise-loop showed positive evidence on the JSON extraction proposal after successful completion and rejudge.
```

```text
deep-review tied plain on hidden seeded answer-key coverage, 3/3 vs 3/3.
```

Unsafe:

```text
pi-workflow recipes generally outperform plain Pi.
```

```text
plain definitively won 4/5 in a release-grade sense.
```

```text
deep-review is worse than plain based on the contaminated blind score.
```

```text
research citation/coverage was verified.
```

```text
the result generalizes across models/providers.
```

## Ordered next actions

1. Fix runner measurement bugs:
   - tie threshold equality/epsilon;
   - normalizer so `ab-execution` paths are not rewritten.
2. Rejudge existing Kimi artifacts after those fixes.
3. Add dimension-level score reporting and raw judge attempt artifact indexing.
4. Run human spot-check for `research-agent-evals` and `revise-json-extraction-proposal` coverage criteria.
5. Strengthen `review-seeded-safety-diff` with more defects and false-positive traps.
6. Redesign `decision-debate` stage dependencies and final output schema.
7. Cap/default-shrink `deep-research` and `migration` fanout.
8. Add cross-model judge and repeat runs before release/readme claims.
9. Add cost/latency/task-count ROI section to reports.

## Final recommendation

Do not make public-facing quality claims yet. First fix the tie-threshold and normalizer bugs, then rejudge the existing Kimi artifacts. After corrected evidence, decide recipe improvements in this order:

1. `decision-debate`
2. `deep-research`
3. `migration`
4. `deep-review` fixture expansion
5. `revise-loop` timeout/completion budget
