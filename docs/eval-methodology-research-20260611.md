# Eval Methodology Research — 2026-06-11

Sources, three tracks:
1. Kimi xhigh subagent, offline (local design docs/panel reviews + their cited papers) — `.pi/agent/runs/run_mq8stq25_144c58/`
2. Direct web research (arXiv/ACL 2024–2026, framework docs)
3. Kimi xhigh subagent, web-enabled rerun (fetched primary sources directly) — `.pi/agent/runs/run_mq8tc1tb_3ed4bf/`

Strong = paper/measured/official source; Weak = blog/opinion.

## 1. LLM-as-judge: pairwise vs absolute

- **(Strong)** Position bias is real and measured across 15 judges; mitigation = swapped positions + consistency metrics (repetition stability, position consistency, preference fairness). [ACL IJCNLP 2025](https://aclanthology.org/2025.ijcnlp-long.18/)
- **(Strong, counterpoint)** Pairwise is NOT strictly better: pairwise protocols are *more vulnerable to distraction/manipulation* — generators can exploit spurious features to win comparisons; absolute scoring is more robust to such manipulation. [arXiv:2504.14716](https://arxiv.org/pdf/2504.14716)
- **(Strong)** TrustJudge: pointwise and pairwise judgments are mutually inconsistent in measurable ways; distributional scoring (use the judgment distribution, not a single sample) alleviates this. [arXiv:2509.21117](https://arxiv.org/html/2509.21117), [ACL Findings 2025](https://aclanthology.org/2025.findings-emnlp.1259.pdf)
- **(Strong)** Rubric *option order* also induces bias, not just output order — swap rubric permutations too. [arXiv:2602.02219, 2604.23178 via local research notes]

**Implication for roadmap 1**: keep absolute scoring as the base (it resists manipulation), ADD pairwise+swapped as a near-tie resolver rather than replacing absolute. Treat disagreement between protocols as `unresolved`.

## 2. Reducing run-to-run judge variance (our ±1.0 problem)

- **(Strong)** Temperature 0 does NOT make judges consistent: substantial inconsistency persists across repeated runs even at T=0; completeness-type criteria are the most unstable. [arXiv:2603.04417](https://arxiv.org/pdf/2603.04417)
- **(Strong)** What actually works: **criteria injection + ensembling (k≈8 independent calls, averaged)** account for nearly all available gains (+13.5pp on RewardBench 2); calibration/routing/soft-blending do not reliably help. [arXiv:2604.13717](https://arxiv.org/pdf/2604.13717), [composo-ai/llm-judge-criteria-ensembling](https://github.com/composo-ai/llm-judge-criteria-ensembling)
- **(Weak)** One repo reports T=0 single-judge per-item std 0.02 vs 0.40 at T=0.6 for a specific VL model — model-dependent, conflicts with the stronger paper above. [diffujudge-av](https://github.com/syedhumarahim/diffujudge-av)

**Implication**: our measured "in-batch stddev 0, cross-run ±1.0" matches the literature (provider-side nondeterminism + prompt sensitivity, not sampling temperature). Fix = k-sample ensembling ACROSS runs/sessions, cross-provider judge, and per-dimension criteria injection. We already have `--judge-samples`; the gap is that samples share one session/cache.

## 3. Small-n statistics (tasks < 20)

- **(Strong)** Don't use CLT-based confidence intervals under a few hundred datapoints — they are badly mis-calibrated in small-n regimes; use exact/Bayesian methods. [arXiv:2503.01747](https://arxiv.org/pdf/2503.01747)
- **(Strong)** Anthropic's error-bars guidance: report **paired differences** per task (paired analysis exploits task-level covariance; much tighter than unpaired). [arXiv:2411.00640](https://arxiv.org/pdf/2411.00640)
- **(Strong)** Resolution diagnostics: before claiming a winner, check whether the eval has the *resolution* to support the claim (paired bootstrap CI on the mean difference; if it contains zero, say so). [arXiv:2605.30315](https://arxiv.org/html/2605.30315)
- **(Strong, via local notes)** Parloa: hierarchical Bayesian (Beta-Binomial partial pooling) avoids false positives that i.i.d. win-rate aggregation produces even in A/A.

**Implication for roadmap 2**: 10+ tasks is necessary but the bigger win is *paired* reporting per task + exact binomial/bootstrap CI, and reporting "unresolved" when CI spans zero. 3–5 tasks per task-class with repeated judging is defensible diagnostic evidence.

## 4. Agent/multi-step evaluation design

- **(Strong)** tau2-bench: evaluate by **end-state equivalence** (replay reference trajectory → compare DB end-state hash), not by matching the exact action sequence — any tool path reaching an equivalent end state passes. [tau2-bench docs](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md)
- **(Strong)** AgentLens "lucky pass problem": outcome-only scoring treats principled solutions and chaotic trial-and-error as equal; trajectory-level process references reveal the difference. [arXiv:2605.12925](https://arxiv.org/html/2605.12925v3)
- **(Strong)** Berkeley RDI: automated audit of 13 major agent benchmarks found score inflation in several (incl. tau-bench, GAIA) — benchmark evaluation code itself is a bug surface; verify harness logic. [rdi.berkeley.edu](https://rdi.berkeley.edu/blog/trustworthy-benchmarks/)
- **(Strong, via local notes)** BenchAgent: of 6 MAS variants only 1 beat a compute-matched single-agent anchor; MAS gains are task/protocol-specific. Depth (multi-step chains) predicts MAS gains more than width.
- **(Weak)** 2026 practice: measure outcome + trajectory + tool use + cost simultaneously. [CallSphere blog](https://callsphere.ai/blog/agent-evaluation-2026-trajectory-tool-use-cost-metrics)

**Implication for roadmap 2/3**: prefer tasks with *verifiable end states* (executable tests, DB-state-style checks) over keyword answer keys; tag tasks with depth/width metadata; compute-matched baseline is confirmed as essential (BenchAgent anchors).

## 5. Frameworks: build vs borrow

- Inspect AI (UK AISI) has built-in stderr()/paired statistics; promptfoo/braintrust cover prompt-matrix evals. None natively provide our combination: worktree isolation + hidden answer keys + blind labels + leak audit + workflow-arm orchestration.
- **Implication for roadmap 5**: keep the runner custom; borrow *statistics* (paired bootstrap, exact binomial) and optionally export results in a schema importable by Inspect-style tooling. Do not migrate.

## 6. Cost/ROI reporting

- **(Strong, via local notes)** Anthropic: MAS uses 3–10x tokens; ties at higher cost are ROI-negative findings, not neutral. Local panel review: "tying with 58 tasks vs 1 task is poor product ROI."
- **Implication**: token/cost accounting belongs in the report header, not roadmap-5 backlog. "Win margin per cost" is the decision metric.

## Top-3 corrections to our roadmap (both research tracks agree)

1. **Roadmap 1 as written is incomplete.** Output-order swap alone leaves rubric-order bias and protocol inconsistency. Revised: absolute (anchored, criteria-injected) stays primary; add k-ensemble across sessions + cross-provider judge + pairwise-swapped only as near-tie resolver; disagreement ⇒ unresolved.
2. **Roadmap 2's bottleneck (hand-written answer keys) is partially self-inflicted.** Prefer end-state-verifiable tasks (executable tests, seeded-defect patches with mechanical checks) over keyword matching; keyword keys stay only for prose-output tasks.
3. **Statistics before scale.** Paired-difference reporting + exact small-n CI ("resolution diagnostics") is cheaper than adding tasks and prevents over-claiming from whatever n we have. Add before expanding the task set.

## Single best next step (consensus of both tracks)

**Add the compute-matched `plain-self-check` arm (draft → self-revise) + paired-difference reporting with exact CI, then rerun the suite.** One cheap arm removes the biggest confounder (structure vs extra compute); paired stats make any n meaningful; everything else (pairwise judging, task expansion) builds on this clean baseline.

---

# Round 2: web-enabled Kimi rerun (2026-06-11, run_mq8tc1tb_3ed4bf)

Focus: questions round 1 could not cover. Confirms round-1 conclusions with primary sources and adds the following.

## R2-1. Judge ensemble independence vs provider caching

- **(Strong)** Provider prefix caching is real and auditable ([arXiv:2502.07776](https://arxiv.org/pdf/2502.07776)); our "in-batch stddev 0" is consistent with cache/batch determinism, while cross-run ±1.0 matches T=0 nondeterminism ([arXiv:2603.04417](https://arxiv.org/pdf/2603.04417)).
- **Action**: inject a random nonce at the head of each ensemble judge call to break prefix-cache correlation; force CoT rationale before the score (rationale-first reduces cross-run variance).

## R2-2. Judge frameworks under local-CLI constraints (no logprobs)

- **(Strong)** G-Eval and TrustJudge's distribution-sensitive scoring need logprobs — **not applicable** to our CLI judges (Anthropic/reasoning models hide logprobs).
- **(Strong)** TrustJudge ([arXiv:2509.21117](https://arxiv.org/html/2509.21117)): expanding scale granularity 5→10/100 + likelihood-aware aggregation cuts score-comparison inconsistency 8.4pp and transitivity violations 10.8pp — the granularity part is prompt-only, works without logprobs, and complements our anchored rubric.
- **(Strong)** VERDI ([arXiv:2605.11334](https://arxiv.org/html/2605.11334)): trace-based confidence (does the judge's reasoning contradict its score?) works without logprobs; lightweight regex/NLI check.
- **Action**: widen score scale to 10 (keep anchors); add a cheap self-contradiction check on judge notes vs score.

## R2-3. Automated seeded-defect task generation (answer-key bottleneck)

- **(Strong)** SWE-Mutation ([arXiv:2605.22175](https://arxiv.org/html/2605.22175)), SWE-ABS ([arXiv:2603.00520](https://arxiv.org/pdf/2603.00520)): LLM-driven mutation of golden solutions generates realistic buggy fixtures at scale; SWE-ABS found ~1/5 of "solved" SWE-bench patches semantically wrong. CR-Bench ([arXiv:2603.11078](https://arxiv.org/html/2603.11078)) scores review agents by line-level bug-hit utility.
- **Action**: prototype "golden fixture → LLM bug injection → mechanical check" pipeline to scale the review-task family without hand-written keys.

## R2-4. Latest MAS-vs-single evidence (sharpens our hypothesis)

- **(Strong)** BenchAgent details: only EvoAgent (+1.44pp, within Wilson 95% CI) beat the single anchor; 5 of 6 MAS lost by 2.5–11pp. BUT Claude-Code-style runtime workflow won GAIA L2/3 by 20+pp — orchestration *quality* matters, not agent count ([arXiv:2606.05670](https://arxiv.org/html/2606.05670)).
- **(Strong)** Information-theoretic result ([arXiv:2604.02460](https://arxiv.org/html/2604.02460)): under equal thinking-token budget, single-agent dominates MAS on multi-hop reasoning unless single-agent context utilization is degraded (long/noisy context). This predicts *when* our workflow should win: long-horizon, context-overflow tasks.
- **Action**: tag tasks by context-pressure; expect workflow wins only there; use Wilson CI for win-rate claims.

## R2-5. Inspect AI paired statistics — verified against source

- **(Strong)** Inspect AI's `stderr` is CLT-based and has **no paired statistics** ([source](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/scorer/_metrics/std.py)) — confirms we must implement paired bootstrap CI ourselves (small mjs function; port their bootstrap_stderr logic applied to per-task diffs).

## R2-6. Small-team eval operations (Anthropic/OpenAI official guidance)

- **(Strong)** Anthropic ([demystifying-evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)): start with 20–50 tasks; separate **capability suite** (low pass rate, drives improvement) from **regression suite** (must stay passing); prefer deterministic graders; clean-environment isolation is mandatory (validates our worktree work).
- **(Strong)** OpenAI ([eval-skills](https://developers.openai.com/blog/eval-skills)): 10–20 prompts per skill, deterministic checks before rubric grading.
- **(Weak)** Eval-author monoculture warning: one author writing >40% of tasks makes the benchmark a self-portrait.
- **Action**: promote current 2 tasks to regression suite; build new tasks as capability suite.

## R2 corrections to round-1 conclusions

| Round-1 claim | Round-2 refinement |
|---|---|
| k≈8 ensemble is the main variance fix | Granularity expansion (5→10/100) + aggregation rules achieve much of the gain **without** ensemble cost (TrustJudge) |
| Pairwise is manipulable — use cautiously | Don't discard pairwise; bidirectional probability aggregation fixes its transitivity problems |
| T=0 doesn't fix inconsistency | True, but trace-based confidence (VERDI) identifies *which* judgments to trust |

## Updated next-step sequence (merged)

1. **Now**: nonce injection + CoT-rationale-first judge prompt + score scale 5→10 (prompt-only changes)
2. **Short**: paired bootstrap CI in mjs + compute-matched `plain-self-check` arm → rerun suite
3. **Mid**: mutation-based task generation pipeline; split regression/capability suites; 20+ tasks
