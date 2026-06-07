# A/B/C Methodology Research — 2026-06-07

External research notes for the pi-workflow A/B/C runner. This is a research/design
capture only. No runner changes are implemented from this document yet; the immediate
next work is fixing the panel-reported tie-threshold and path-normalizer bugs (see
`docs/ab-execution-panel-review-20260607.md`).

## Why this research

The current runner compares a workflow arm, a plain single-Pi arm, and an optional
research fanout arm, then scores blind outputs with an LLM judge. The latest Kimi
evidence is diagnostic only, and the panel flagged tie-threshold fragility and
single-run/single-judge limits. This note collects external methodology that is
relevant to those exact weaknesses.

## Sources

- TeamBench: Multi-Agent Teamwork Benchmark with OS-Enforced Role Separation — https://teambench.github.io/ (arXiv:2605.07073)
- Parloa: How to A/B Test AI Agents With a Bayesian Model — https://www.parloa.com/labs/research/ai-agent-testing/
- Judging the Judges: Position Bias in LLM-as-a-Judge (balanced permutation) — https://arxiv.org/pdf/2602.02219
- Judging the Judges: Bias Mitigation Strategies in LLM-as-a-Judge Pipelines — https://arxiv.org/html/2604.23178
- When Do Multi-Agent LLM Systems Outperform Single-Agent Approaches — https://ecer.pria.at/archive/ecer-2026/papers/When_Do_Multi-Agent_LLM_Systems_Outperform_Single-Agent_Approaches_An_Empirical_Comparison_Across_Different_Task_Types.pdf (PDF body not extractable in this session; cited from abstract/title only)

## Findings relevant to our runner

### 1. Multi-agent/workflow advantage is conditional on task type

TeamBench measured marginal team value against an unrestricted single-agent oracle:

```text
hardest-task quintile (Q1): +15.7 points
easiest-task quintile:      net loss to coordination overhead
full reference pool mean:   +0.5 points (p = 0.20, not significant)
```

This matches our own Kimi result shape: plain wins migration/decision, workflow wins
revise-loop, others near-tie. The honest framing is "workflow helps on hard/structured
tasks and can hurt on easy ones", not "workflows are generally better".

Implication for us: report results by task difficulty, not as a single aggregate
win/loss tally.

### 2. Compute-matched baselines are required to attribute the win

TeamBench tested Solo-CoT and Solo-2Pass compute-matched baselines; neither closed the
team gap, which let them claim the benefit was structural rather than just extra tokens.

Our `plain` arm is currently one direct single Pi call, while workflow arms run many
tasks. Without a compute-matched plain variant, a workflow win is confounded with simply
spending more tokens.

Implication for us: a stronger plain baseline (for example a 2-pass / self-check plain
arm) would separate "structure helped" from "more compute helped". Deferred.

### 3. Role ablation can reveal harmful stages

TeamBench found LLM Verifiers false-accept ~49% of grader-failing submissions, and that
removing the Verifier improved mean score in their reference ablation. A stage can be
net negative.

Implication for us: when a bundled workflow underperforms plain (decision-debate,
migration), a stage-level ablation could show whether a specific stage is dragging
quality down, instead of treating the workflow as one opaque unit. Deferred.

### 4. LLM judges have position bias; balanced permutation mitigates it

Position-bias research shows judges prefer score options at specific positions in the
rubric/option list, and that aggregating across balanced permutations of option order
both exposes and reduces the bias, improving correlation with humans.

Implication for us: this is directly tied to the panel's tie-threshold finding. A 5.00
vs 4.83 "win" sitting exactly on the tie threshold is the kind of one-point artifact
that position bias and single-pass judging produce. Permuting rubric option order and
re-scoring would test stability. Deferred, but informs how we fix the tie logic.

### 5. Single-point scores hide uncertainty; repeats + intervals are better

Parloa argues agent eval should be probabilistic, not a single win/loss count:

- combine binary checks (Beta-Binomial) with graded LLM-judge scores,
- use a hierarchical model with partial pooling so per-scenario variance does not cause
  overconfident global conclusions,
- report "P(A > B) with a credible interval" instead of one number,
- a non-hierarchical i.i.d. model produced false positives even when comparing an agent
  against itself.

Implication for us: a full Bayesian model is overkill for a local diagnostic runner, but
the principle applies. Repeating each task a few times and reporting win/tie/loss
frequency would directly address the panel's "single-run" concern and make boundary
results read as uncertain rather than decisive. Deferred.

## Candidate runner changes (not implemented)

Ordered by value vs effort. None of these are in scope yet.

1. Report results by task difficulty label instead of a single aggregate tally.
2. Repeat each task a few times (seeds) and report win/tie/loss frequency with a simple
   uncertainty flag, instead of one judged number.
3. Permute rubric option order and re-score to test judge stability (position-bias
   check), feeding a more robust tie decision.
4. Add a compute-matched plain baseline (2-pass / self-check) to separate "structure"
   from "more compute".
5. Add optional stage-level ablation for a workflow that loses to plain, to detect a
   harmful stage.

## Relationship to current next steps

These remain diagnostic-grade ideas. The immediate, already-agreed next work is:

1. Fix tie-threshold/equality handling (floating-point edge at the one-point boundary).
2. Fix the `ab-execution` path-normalizer contamination of real fixture paths.
3. Rejudge the existing Kimi artifact after those fixes.

The methodology changes above should only be considered after the measurement bugs are
fixed, since they all build on a trustworthy scoring path.
