# Large A/B Eval Plan — Kimi-only workflow vs baseline

## Purpose

Run a large, evidence-first evaluation to determine when `pi-workflow` structure outperforms direct Kimi execution. The target comparison is not "which answer sounds better", but whether workflow orchestration produces more verified outcomes with fewer false positives and better artifact quality.

Primary question:

> With the model held constant (`kimi-coding/kimi-for-coding`), does workflow structure improve objective task outcomes versus plain and compute-matched baselines?

Secondary questions:

1. Does workflow reduce false positives and overconfident claims?
2. Does workflow convert findings into executable evidence more reliably?
3. Does any advantage survive a compute-matched self-check baseline?
4. Which task classes benefit: static review, dynamic review, research, implementation/repair?
5. How much of the result is execution variance, judge variance, or answer-key extraction variance?

## Fixed model policy

All model-backed execution uses Kimi.

| Use | Model | Thinking | Rationale |
|---|---|---|---|
| Dev/debug smoke | `kimi-coding/kimi-for-coding` | `low` | Fast feedback, runner/scorer bug discovery |
| Calibration subset | `kimi-coding/kimi-for-coding` | `low` and selected `xhigh` | Measure reasoning-budget effects |
| Final/holdout execution | `kimi-coding/kimi-for-coding` | `xhigh` | Best-effort comparison |
| Blind judge | `kimi-coding/kimi-for-coding` | `xhigh` | Strong fixed evaluator |
| Answer-key extraction | `kimi-coding/kimi-for-coding` | `xhigh` | Strong fixed structured extractor |

Do **not** mix providers in the first large run. Multi-provider comparison is a later robustness study.

## Evaluation principles

1. **Objective signals first**: command logs, tests, answer keys, RED/GREEN evidence, citation/source checks.
2. **Blind judge second**: useful for report quality but never the sole winner signal when objective signals exist.
3. **No holdout tuning**: after calibration freeze, do not update workflow, scorer, answer key, or matcher based on holdout outputs.
4. **Compute controls**: include `plain-self-check` so workflow wins are not merely "more thinking" wins.
5. **Artifact-first scoring**: prefer structured run artifacts and logs over final-report prose.
6. **Fail closed**: extraction/scoring failure makes the affected comparison unscored, never partially compared.
7. **Clean isolation**: every arm runs in a disposable worktree; no candidate sees private keys, prior eval outputs, or scorer prompts.

## Task suites

### Suite A — Static seeded review

Purpose: maintain continuity with existing seeded-diff review tasks.

Signals:

- structured answer-key recall
- false-positive traps
- severity/tier breakdown
- blind judge as secondary signal

Known limitation: current static fixtures are near ceiling for Kimi. Keep this suite as a regression/precision signal, not as the primary discriminator.

Initial size target: 10–20 tasks after expanding beyond the current fixtures.

### Suite B — Dynamic seeded review (primary)

Purpose: break the static-review ceiling by requiring executable evidence.

Task behavior:

1. apply a proposed patch in a disposable worktree,
2. identify suspected regressions,
3. write smallest repro tests,
4. run narrow validation commands,
5. report RED evidence and optional GREEN/fix evidence.

Primary scoring:

- seed reproduced with targeted test
- patched code produces RED evidence
- optional fix/revert produces GREEN evidence
- trap hunks do not receive defect claims/tests
- scope hygiene: no unrelated rewrites or broad test changes
- command evidence is exact and inspectable

Initial size target:

- pilot: 1 then 5 tasks
- calibration: 5–10 tasks
- holdout: 15–20 tasks

Detailed starter design: `docs/dynamic-review-eval-plan-20260612.md`.

### Suite C — Deep research

Purpose: compare planner/claim-verification workflow against direct and naive-parallel baselines.

Signals:

- required fact-slot coverage
- verified/partial/unsupported claim counts
- exact numeric/policy/date/version source support
- contradiction handling
- citation/source resolution
- blind report quality

Initial size target: 10–20 tasks after dynamic review MVP stabilizes.

### Suite D — Implementation / repair

Purpose: measure whether workflow improves real code changes.

Signals:

- tests pass
- minimal/surgical diff
- issue fixed
- no unrelated changes
- review/QA readiness

Initial size target: defer until dynamic review runner and scoring are stable.

## Arms

Minimum arms for dynamic-review pilot:

| Arm | Purpose |
|---|---|
| `workflow` | Experimental workflow structure |
| `plain` | Direct single Kimi baseline |
| `plain-self-check` | Compute/revision-matched baseline |

Later ablations:

| Arm | Purpose |
|---|---|
| `workflow-lite` | Remove/disable one workflow component to localize value |
| `parallel3`/`parallel5` | Naive parallel baseline |
| `workflow-no-dedup` | Measure deterministic dedup contribution |
| `workflow-no-verifier` | Measure adversarial verification contribution |

Do not add all ablations before the dynamic runner is stable; keep the first pilot interpretable.

## Phased execution plan

### Phase 0 — Dynamic runner prototype

Goal: create a minimal mutation-capable dynamic-review runner.

Scope:

- one task definition format
- one patch fixture
- three arms: workflow/plain/plain-self-check
- runner-applied patch preferred over agent-applied patch
- artifact collection: changed files, test files, command logs, final output
- dynamic answer-key scoring over artifacts/logs

Success criteria:

- the runner completes one local task end-to-end,
- all artifacts needed for scoring are present,
- scorer can distinguish missing evidence from false positives,
- workspace cleanup works,
- no private answer key leaks into candidate workspace.

### Phase 1 — 1-task sequential smoke

Configuration:

```text
tasks = 1
arms = workflow, plain, plain-self-check
executionThinking = low
replicates = 1
concurrency = 1
judgeSamples = 0 or 1
answerKeyExtractionSamples = 1
```

Purpose:

- detect runner bugs,
- verify patch apply and tests,
- validate command log capture,
- inspect scoring by hand,
- fix prompt/artifact shape before scaling.

Allowed changes after Phase 1:

- runner fixes,
- scorer fixes,
- fixture shape fixes,
- workflow prompt/spec fixes.

### Phase 2 — 5-task low pilot

Configuration:

```text
tasks = 5
arms = workflow, plain, plain-self-check
executionThinking = low
replicates = 1
concurrency = 2 to 4
judgeSamples = 1 to 3
answerKeyExtractionSamples = 1
```

Purpose:

- measure task runtime distribution,
- find flaky tests and timeout defaults,
- check if low-thinking reveals workflow differences,
- identify scoring edge cases.

Allowed changes after Phase 2:

- runner/scorer/workflow changes still allowed,
- but every change must be recorded with reason and affected tasks.

### Phase 3 — Calibration

Configuration:

```text
tasks = 5 to 10
arms = workflow, plain, plain-self-check
executionThinking = low for all, xhigh for selected subset
replicates = 2
concurrency = 4
judgeSamples = 3 to 5
answerKeyExtractionSamples = 1 to 3
```

Purpose:

- estimate execution variance,
- estimate extraction variance,
- compare low vs xhigh behavior,
- fix timeout and retry policy,
- freeze scorer/workflow/answer-key versions for holdout.

Freeze after Phase 3:

- workflow specs and prompts,
- runner/scorer version,
- answer-key schemas,
- holdout task definitions,
- pass/fail thresholds.

### Phase 4 — Xhigh holdout

Configuration:

```text
tasks = 15 to 20 dynamic-review holdout tasks
arms = workflow, plain, plain-self-check
executionThinking = xhigh
replicates = 3
concurrency = 8 initially, max 16 only if stable
judgeSamples = 5
answerKeyExtractionSamples = 3
```

Expected executions for 20 tasks:

```text
20 tasks × 3 arms × 3 replicates = 180 executions
```

Holdout rules:

- no scorer/matcher/workflow/prompt updates after seeing outputs,
- if a scoring bug is discovered, record it as future work and keep the frozen analysis separate,
- final claims use frozen scorer results only.

## Dynamic-review runner MVP

### Task schema draft

```json
{
  "id": "dynamic-review-example",
  "targetRepo": "self-or-external-name",
  "fixture": ".pi/eval/dynamic-review/fixtures/example/diff.patch",
  "task": "Apply the patch and write targeted repro tests for regressions.",
  "testCommandAllowlist": ["npm test -- --runInBand path/to/test"],
  "arms": {
    "A": { "type": "workflow", "name": "dynamic-review" },
    "B": { "type": "plain" },
    "C": { "type": "plain-self-check" }
  },
  "answerKeyRef": "private://dynamic-review-example.json"
}
```

### Private answer key draft

```json
{
  "matcherSchema": "dynamic-review-v1",
  "knownIssues": [
    {
      "id": "seed-001",
      "file": "src/foo.ts",
      "symbols": ["validatePort", "65535"],
      "expectedBehavior": "port > 65535 is rejected before crossing the protocol boundary",
      "testSignals": ["rejects port 65536", "RangeError", "invalid port"],
      "redEvidenceRequired": true,
      "greenEvidence": "optional"
    }
  ],
  "falsePositiveTraps": [
    {
      "id": "trap-001",
      "file": "src/bar.ts",
      "symbols": ["Promise.all"],
      "forbiddenSignals": ["race", "TOCTOU", "atomicity"]
    }
  ]
}
```

### Artifact layout draft

```text
runs/<run-id>/
├── manifest.json
├── internal/<task-id>/
│   ├── arm-a/
│   │   ├── output.md
│   │   ├── metadata.json
│   │   ├── workspace-diff.patch
│   │   ├── changed-files.txt
│   │   ├── command-runs.json
│   │   └── test-artifacts/
│   ├── dynamic-score.json
│   └── answer-key-results.json
├── scores/<task-id>.json
└── report.md
```

### Scoring draft

Per known issue:

| Field | Score |
|---|---:|
| relevant file/symbol identified | 1 |
| targeted repro test added | 1 |
| RED command evidence present | 2 |
| optional GREEN/fix evidence present | 1 |
| final report ties test to defect | 1 |

Per trap:

| Trap signal | Penalty |
|---|---:|
| final report claims trap as defect | -2 |
| adds/runs targeted trap repro test | -2 |
| broad unrelated test created because of trap | -1 |

Run-level penalties:

| Issue | Penalty |
|---|---:|
| modifies source outside allowed/test scope | hard failure or -3 |
| no commands run | hard failure |
| command logs missing | hard failure |
| workspace contamination/leak | invalid |

Primary metric:

```text
dynamicObjectiveScore = seed points - trap penalties - run-level penalties
```

Report additionally:

- seed recall with RED evidence,
- trap FP rate,
- scope hygiene failures,
- task completion rate,
- wall-clock/runtime distribution.

## Timeout, retry, and concurrency

Initial defaults:

```text
per-arm timeout = 60 minutes
patch apply timeout = 1 minute
test command timeout = 10 to 15 minutes
answer-key extraction timeout = 15 minutes
judge timeout = existing runner default
```

Retry policy:

- no automatic retry for semantic failures,
- retry once for infrastructure/provider parse failures,
- extraction failure after retry => unscored comparison,
- flaky test command => record inconclusive unless rerun succeeds with identical command and explanation.

Concurrency policy:

| Phase | Concurrency |
|---|---:|
| Phase 1 | 1 |
| Phase 2 | 2–4 |
| Phase 3 | 4 |
| Phase 4 | 8 initially; 16 only after stability |

Reasoning:

- early phases prioritize feedback and diagnosability,
- final phase prioritizes throughput,
- local test contention can masquerade as model failure, so raise concurrency gradually.

## Reporting

Final report must include:

1. frozen versions: commit, workflow SHA, scorer SHA, answer-key SHA, model/thinking,
2. per task/arm/replicate objective scores,
3. paired diffs: workflow - plain, workflow - self-check,
4. bootstrap confidence intervals over task-level paired differences,
5. A/A or replicate variance estimate,
6. trap FP rates,
7. completion/timeout rates,
8. representative artifacts and failure cases,
9. known limitations and excluded/inconclusive tasks.

Victory claim template:

```text
Workflow is considered better for this suite only if:
- mean objective paired diff vs plain is positive,
- bootstrap CI excludes zero,
- margin exceeds A/A / replicate noise floor,
- trap FP rate is not worse,
- completion rate is not worse,
- result survives plain-self-check comparison.
```

## Immediate next implementation steps

1. Add a dynamic-review task registry separate from static `tasks.json` or extend the current schema with `taskKind`.
2. Implement runner-applied patch and mutable per-arm worktrees.
3. Add command-run capture (`command-runs.json`) with exact command, cwd, exit code, stdout/stderr paths, timeout flag.
4. Add dynamic answer-key scorer over artifacts/logs.
5. Create one seed fixture from an existing RED/GREEN-verified defect.
6. Run Phase 1: one task, three arms, `kimi low`, concurrency 1.
7. Inspect artifacts manually before scaling.

## Open decisions

1. Should dynamic review allow source fixes after writing tests, or only repro tests? Recommendation: Phase 1 repro tests only; add fixes/GREEN later.
2. Should runner apply the patch before the arm starts? Recommendation: yes, to avoid base-vs-patch confusion.
3. Should test commands be selected by the arm or constrained by allowlist? Recommendation: allow arm selection from a task allowlist plus freeform proposal recorded as not-run unless safe.
4. Should plain arms be allowed to write source code fixes? Recommendation: no for repro-only phase.
5. What is the first target repo? Recommendation: this repo first, then gondolin after runner is stable.
