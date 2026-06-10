# General A/B Evaluation Harness Design

## Purpose

Build a general-purpose local evaluation harness for comparing Pi execution strategies under controlled, auditable conditions.

The harness should compare outputs from strategies such as:

- plain single Pi
- plain two-pass / self-check Pi
- specialist agent runs
- workflow runs
- naive parallel fanout
- model A vs model B
- prompt A vs prompt B
- tool-enabled vs no-tool configurations

The goal is **diagnostic evidence**, not universal benchmark proof. A result should answer:

> Under this task set, model/provider, tool surface, isolation policy, and judging protocol, which strategy appears stronger, at what cost, and with what uncertainty?

## Non-Goals

- Do not claim global workflow superiority from one task or one model.
- Do not treat LLM judge scores as ground truth.
- Do not expose hidden answer keys or prior eval artifacts to candidate arms.
- Do not rely on output formatting/schema as a quality proxy.
- Do not silently continue when requested isolation fails.

## Key Design Principles

### 1. Symmetric Information Conditions

All arms should receive the same task brief, allowed tools, and accessible workspace content unless the experiment explicitly varies those factors.

Evaluation-only artifacts must not be visible to arms:

- answer keys
- scoring rubrics intended only for judges/checkers
- prior run reports
- prior panel reviews
- task-generation notes
- hidden fixtures

### 2. Symmetric Output Capture

Every arm must produce the same candidate package shape:

```text
final.md              # only this is submitted to judge
metadata.json         # runtime metadata, internal only
stdout.raw.log        # internal only
stderr.raw.log        # internal only
tool-calls.jsonl      # internal/audit only when available
```

Raw stderr, process warnings, run IDs, tool logs, and orchestrator messages must not be submitted as candidate output.

### 3. Objective Checks Before Judge Taste

When possible, the harness should compute objective or semi-objective signals before LLM judging:

- executable test pass/fail
- hidden answer-key coverage
- required fact-slot coverage
- citation URL resolve rate
- citation support spot-check
- forbidden eval-artifact access audit
- tool-call/tool-availability audit
- mutation/seeded-defect hit rate

LLM judging should primarily assess prose quality, prioritization, clarity, calibration, and actionability after objective checks.

### 4. Judge Variance Is Measured, Not Assumed Away

The harness should support:

- A/A noise-floor runs
- k-sample judging per output
- pairwise judging with swapped positions
- cross-provider judging
- reporting mean, standard deviation, and unresolved/tie states

A winner should not be declared when the gap is within the measured noise floor.

### 5. Cost and Latency Are First-Class

For orchestration products, quality alone is insufficient. Reports should include:

- wall-clock time
- task count
- tool-call count
- token estimate or actual token usage when available
- cost estimate or actual cost when available
- quality per cost / ROI frontier

A workflow that ties plain at much higher cost should be reported as an ROI concern, not a neutral tie.

## Proposed Evaluation Spec

Example:

```json
{
  "schemaVersion": 1,
  "name": "coding-agent-research-eval",
  "isolation": {
    "mode": "worktree",
    "exclude": [
      ".pi/eval/**",
      "evals/ab-execution/**",
      "docs/ab-execution*",
      "docs/deep-research-*",
      ".pi/skill-runs/**"
    ]
  },
  "judge": {
    "mode": "absolute",
    "model": "kimi-coding/kimi-for-coding",
    "thinking": "medium",
    "samples": 3,
    "rubric": "rubrics/research-quality.md"
  },
  "tasks": [
    {
      "id": "vendor-fact-table",
      "class": "fact-verification",
      "expectedAdvantage": "workflow",
      "task": "Compare five coding-agent tools across auth, headless mode, tool calling, extension model, context, pricing/cache, and license constraints. Use primary sources where available.",
      "answerKeyRef": "../private-eval-keys/vendor-fact-table.json",
      "coverageCriteria": {
        "requiredAxes": ["auth", "headless", "tools", "extensions", "context", "pricing", "license"],
        "requiredEntities": ["Claude Code", "Codex CLI", "Gemini CLI", "Kimi", "Pi"],
        "mustCitePrimaryFor": ["pricing", "license", "auth"]
      }
    }
  ],
  "arms": {
    "plain": { "type": "pi", "mode": "single" },
    "plain-self-check": { "type": "pi", "mode": "two-pass" },
    "deep-research": { "type": "workflow", "name": "deep-research", "input": { "depth": "standard" } },
    "parallel5": { "type": "parallel", "agent": "researcher", "fanout": 5 }
  }
}
```

## Arm Types

### `pi` / `single`

One direct Pi process. Must use final-answer delimiters so the harness can separate candidate output from raw stdout/stderr.

### `pi` / `two-pass`

A compute-matched lightweight baseline:

1. draft answer
2. self-check/revise against the task and source requirements

This helps distinguish workflow structure from generic extra compute/revision.

### `workflow`

Runs a named workflow with optional input overrides. If the workflow produces structured internal artifacts, the harness may append a presentation stage so candidate output is comparable.

### `parallel`

A naive parallel fanout baseline using identical agent/tool access. Useful to distinguish workflow-specific structure from generic parallel source gathering.

## Isolation Modes

### `none`

Only for local debugging. Not valid for comparative claims when answer keys or prior eval artifacts exist in the repo.

### `worktree`

Create a sanitized temporary worktree/workspace and remove or omit eval-only artifacts.

Exclusions should include:

```text
.pi/eval/**
evals/ab-execution/**
docs/ab-execution*
docs/deep-research-*
.pi/skill-runs/**
```

This reduces accidental self-contamination, but it is not a security boundary. Processes can still read host paths unless combined with sandboxing or path guards.

### `gondolin`

Run candidate arms inside a Gondolin VM/sandbox with only the sanitized workspace mounted.

Target posture:

```text
host:
  answer keys
  judge/checker
  prior eval artifacts
  provider auth broker if needed

guest:
  sanitized workspace
  candidate arm process
  allowed tools
  controlled network
```

Open design questions:

- Does the guest image have Pi, Node, npm, and required provider packages?
- How are provider credentials exposed without mounting all of `~/.pi/agent`?
- Should web access be open, allowlisted, or mediated?
- How should local file dependencies such as `../pi-subagent-engine` be mounted?
- Should missing sandbox support fail closed? For evaluation-quality isolation, yes.

## Hidden Answer Keys

Answer keys should be stored outside any arm-visible workspace:

```text
private-eval-keys/<task>.json
```

The public task spec should include only:

```json
"answerKeyRef": "../private-eval-keys/task.json"
```

The harness resolves the key on the host after candidates finish.

For legacy tasks where `answerKey` still lives in `tasks.json`, the harness should warn that the task is not isolation-safe unless the candidate workspace omits that file.

## Candidate Output Normalization

Normalization should be conservative. It may strip true identifiers:

- workflow run IDs
- eval run IDs
- artifact paths
- internal claim IDs
- internal slot IDs

It must not rewrite domain language such as:

- workflow
- single-agent baseline
- agent
- benchmark
- Markdown headings

## Objective Audits

### Citation Resolve Audit

Extract URLs from candidate outputs and check whether they resolve. Report:

```text
urlCount
checkedCount
resolvedCount
resolveRate
per-URL status/effective URL
```

A bot-protected 403 should be flagged but not automatically treated as hallucination.

### Citation Support Audit

Future work. For sampled claim/URL pairs:

1. fetch source content
2. identify the sentence/claim attached to the URL
3. ask a tool-enabled verifier whether the source supports, partially supports, contradicts, or does not mention the claim

This should be separate from the no-tools judge.

### Eval Artifact Access Audit

Scan candidate outputs and tool-call logs for paths such as:

```text
.pi/eval/
evals/ab-execution/
docs/ab-execution*
docs/deep-research-*
.pi/skill-runs/
```

Any hit should be reported. In strict mode it should invalidate the run.

## Judging Modes

### Absolute Scoring

Judge sees one candidate output at a time and scores dimensions. Good for independent diagnostics, weak near the ceiling.

### k-Sample Absolute Scoring

Judge each output `n` times and report:

```text
mean
stddev
hard failure frequency
notes per sample
```

### A/A Noise-Floor Mode

Map every blind label to the same configured arm. This estimates judge variance and label/noise effects.

### Pairwise + Swapped Position

Future primary winner mode for near-ties:

```text
A vs B
B vs A
```

Winner only if stable under position swap.

### Cross-Provider Judge

Run at least one judge from a different provider than the executor. If judges disagree on winner, report unresolved rather than averaging into false certainty.

## Reporting

Reports should separate:

1. Blind output quality
2. Objective checks
3. Citation and artifact audits
4. Cost/latency/tool-call ROI
5. System mapping revealed
6. Known limitations and noise floor

Example winner language:

```text
winner: unresolved
reason: workflow and plain differ by 0.12, below A/A noise floor 0.18
```

or:

```text
winner: workflow on objective fact-slot coverage
ROI: workflow used 12x tool calls and 4x wall time; quality gain may not justify cost
```

## Migration From Current Runner

Current runner already has:

- blind labels
- manifests and hashes
- workflow/plain/parallel arms
- final-answer delimiters for plain
- rubric injection
- conservative normalization
- citation URL resolve audit
- eval artifact access audit
- k-sample judge aggregation
- A/A mode
- tool-call audit ingestion for workflow subagents

Needs extraction/generalization:

- move from `.pi/eval/ab-execution/run.mjs` to `src/eval/` or `evals/ab-execution/`
- formalize eval spec schema
- add sanitized worktree mode
- add Gondolin mode
- support external `answerKeyRef`
- add compute-matched baselines
- add pairwise swapped judging
- add semantic citation support auditing
- add token/cost accounting

## Recommended Next Implementation Steps

1. Add `answerKeyRef` and move hidden keys outside arm-visible task specs.
2. Add sanitized worktree isolation mode.
3. Add strict eval-artifact deny/audit mode.
4. Add plain two-pass baseline.
5. Add pairwise swapped judging.
6. Prototype Gondolin execution for candidate arms.
7. Build a held-out fact-verification-heavy task set.

## Open Questions

- Should the general harness be part of `pi-workflow` or a separate package/extension?
- Should `/workflow eval` be the public command, or should this remain an internal eval tool initially?
- How much isolation is required for diagnostic local use versus publishable evidence?
- Should all research tasks require citation resolve/support audits by default?
- What is the minimum task count before a workflow-vs-plain claim can be made?
