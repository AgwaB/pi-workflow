# Task-Fit Research for Workflow/Subagent A/B Evaluation — 2026-06-07

This note captures research and discussion about when workflow/subagent execution is
expected to beat, tie, or lose to a strong plain single-Pi baseline. It is intentionally
methodology-focused and does not change runner behavior by itself.

## Core conclusion

The useful question is not:

```text
Are workflows better than plain single Pi?
```

The useful question is:

```text
Does this task's structure match the workflow/subagent protocol well enough to justify
extra coordination, latency, and token cost?
```

Across papers, engineering posts, and our local A/B/C evidence, the recurring pattern is:

- workflow/subagent systems help when they solve a real bottleneck: depth, breadth,
  verification, context isolation, tool/domain specialization, or recoverable state.
- plain single-agent execution remains strong when the task needs one coherent synthesis,
  straight-line planning, tight shared context, or has low depth/width.
- aggregate win/loss counts are misleading unless reported by task class and workflow fit.

## Sources reviewed

### Empirical / benchmark papers

1. **Do More Agents Help? Controlled and Protocol-Aligned Evaluation of LLM Agent Workflows**
   - URL: https://arxiv.org/html/2606.05670v1
   - Key terms: BenchAgent, workflow lift, matched single-agent anchor, protocol-aligned comparison.
   - Main takeaways:
     - Adding agents does not reliably improve accuracy when benchmark loader, tools,
       answer contract, usage accounting, trajectory logging, and evaluator are aligned.
     - Under substrate-internal conditions, only one of six MAS variants numerically beat
       the matched single-agent anchor, and that gap was within one-run uncertainty.
     - Several MAS variants were worse and more expensive.
     - MAS gains were task/protocol specific, not a function of agent count.
     - Debate helped on tasks where independent proposals are checkable (e.g. HumanEval,
       MATH in that paper).
     - Runtime-generated workflow helped on GAIA Level 2/3 where long-horizon tool use,
       state preservation, evidence artifacts, and verification mattered.
     - Handoffs can lose task-critical constraints; traces are needed to see this.
   - Direct relevance to pi-workflow:
     - Our runner should report task/protocol fit and operational metadata, not only final
       quality scores.
     - A workflow win should not be attributed to "more agents" without ablation evidence.
     - Runtime workflow value is strongest when state and verification failures are made
       local/recoverable.

2. **On the Importance of Task Complexity in Evaluating LLM-Based Multi-Agent Systems**
   - URL: https://arxiv.org/html/2510.04311
   - Key terms: task depth, task width, task complexity, multi-agent debate.
   - Main takeaways:
     - Task complexity is modeled with two dimensions:
       - `depth`: length of the sequential reasoning/problem-solving chain.
       - `width`: breadth of capabilities, domains, constraints, or alternatives needed
         at each step.
     - Multi-agent advantage increases with both depth and width.
     - Depth matters more strongly than width because single-agent errors compound across
       long chains.
     - Width benefits can saturate; breadth alone is not enough to justify unlimited fanout.
     - Benchmarks should be designed to test when collaboration is genuinely necessary,
       not merely adapted from single-agent tasks.
   - Direct relevance to pi-workflow:
     - `taskClass` alone is insufficient; runner metadata should track drivers like
       `high-depth` and `high-breadth`.
     - A broad but shallow task may not justify a large workflow.
     - Long sequential tasks with checkpoints are better workflow candidates.

3. **TeamBench: A Multi-Agent Teamwork Benchmark with OS-Enforced Role Separation**
   - URL: https://teambench.github.io/ (arXiv:2605.07073)
   - Key terms: role ablation, Planner/Executor/Verifier, Teamwork Necessity Index,
     structural enforcement.
   - Main takeaways:
     - Team value is conditional: hardest-task quintile gained about +15.7 points, while
       easiest tasks lost points to coordination overhead.
     - Overall mean team-vs-solo uplift was small and not statistically significant in the
       cited reference pool.
     - Verifiers can be harmful: LLM verifiers false-accepted many grader-failing runs.
     - Role ablations are important to know whether Planner, Executor, or Verifier helps.
     - Prompt-only role separation can hide role collapse; structural evidence matters.
   - Direct relevance to pi-workflow:
     - We should separate "workflow helps on hard tasks" from global superiority claims.
     - For weak workflows, stage-level ablation may be more useful than another aggregate
       A/B run.
     - Verification stages need concrete success criteria; otherwise they can rubber-stamp.

4. **Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent Baseline**
   - URL: https://arxiv.org/abs/2601.12307v1
   - Main takeaways from abstract/search result:
     - Homogeneous multi-agent workflows can sometimes be simulated or matched by a strong
       single agent with a strong baseline protocol.
     - Multi-agent comparisons must use strong single-agent baselines, not bare model calls.
   - Direct relevance to pi-workflow:
     - Plain single Pi should remain a serious baseline.
     - Future compute-matched baselines may be needed before claiming structure-specific
       workflow lift.

5. **Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning Under Equal
   Thinking Token Budgets**
   - URL: https://arxiv.org/pdf/2604.02460
   - Main takeaway from search result:
     - Under equal reasoning-token budgets and strong context use, a single agent can match
       or outperform MAS on multi-hop reasoning.
   - Direct relevance to pi-workflow:
     - Token budget confounds matter. A workflow win may be "more compute" rather than
       "better structure" unless a compute-matched baseline exists.

6. **Single-agent or Multi-agent Systems? Why Not Both?**
   - URL: https://arxiv.org/html/2505.18286v1
   - Main takeaway from search result:
     - Frontier model improvements reduce the default advantage of MAS.
     - A hybrid/selective approach is preferable: choose single-agent or multi-agent based
       on request/task characteristics.
   - Direct relevance to pi-workflow:
     - The product should recommend workflows conditionally, not route every complex task
       into orchestration.

7. **When Parallelism Pays Off: Cohesion-Aware Task Partitioning for Multi-Agent Coding**
   - URL: https://arxiv.org/html/2606.00953
   - Main takeaway from search result:
     - Parallelism pays when tasks can be partitioned into cohesive subtasks with low
       cross-partition communication.
     - Communication-to-computation tradeoff is the key coding-agent constraint.
   - Direct relevance to pi-workflow:
     - Good workflow candidates have clean interface boundaries.
     - Tightly coupled implementation/refactor work should not be naively split.

8. **When Do Multi-Agent LLM Systems Outperform Single-Agent Approaches?**
   - URL: https://ecer.pria.at/archive/ecer-2026/papers/When_Do_Multi-Agent_LLM_Systems_Outperform_Single-Agent_Approaches_An_Empirical_Comparison_Across_Different_Task_Types.pdf
   - Note: PDF body was not extractable in this session; only title/abstract/search snippets
     were used.
   - Main takeaway from abstract/snippet:
     - The practical tradeoff differs across heterogeneous task types such as bug fixing,
       multi-file coding, CSV analysis, documentation, and decision/planning work.
   - Direct relevance to pi-workflow:
     - Our eval suite should cover task categories, not just examples where workflows are
       expected to win.

### Practical engineering guidance

9. **Anthropic: Building Effective Agents**
   - URL: https://www.anthropic.com/engineering/building-effective-agents
   - Main takeaways:
     - Start with the simplest solution that works.
     - Workflows are predictable predefined code paths; agents are dynamic and choose next
       steps at runtime.
     - Agentic systems trade latency/cost for possible task performance.
     - Add agency/complexity only when the flexibility clearly justifies it.
   - Direct relevance to pi-workflow:
     - Predefined bundled workflows should stay simple and explicit.
     - Workflow recommendation should avoid universal claims.

10. **Anthropic/Claude: Building multi-agent systems — When and how to use them**
    - URL: https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
    - Main takeaways:
      - Teams often build multi-agent systems where improved single-agent prompting would
        match or beat them.
      - Multi-agent implementations often use 3–10x more tokens.
      - Multi-agent systems consistently help in three situations:
        1. context protection,
        2. parallelization,
        3. specialization.
      - Context protection is useful when a subtask produces lots of context (>~1000 tokens)
        but only a compact summary is needed by the parent.
      - Parallelization helps coverage/thoroughness more than speed.
      - Specialization helps when tool/domain boundaries are clear and routing is reliable.
      - Decompose by context boundary, not by problem type.
      - Problem-centric splits like planner/implementer/tester/reviewer for the same feature
        often create telephone-game handoff loss.
      - Verification subagents work well when they can blackbox-check artifacts with clear
        criteria.
      - Verifiers suffer an "early victory" failure mode unless explicitly required to run
        comprehensive checks.
    - Direct relevance to pi-workflow:
      - `deep-research` fits parallelization/context isolation.
      - `deep-review` fits verification if evidence criteria are concrete.
      - `implement` may violate context-centric decomposition if plan/validation/implementation
        slices require too much shared context across agents.
      - `migration` may over-fanout when the request is only a straight-line plan.

11. **Anthropic: How we built our multi-agent research system**
    - URL: https://www.anthropic.com/engineering/multi-agent-research-system
    - Main takeaways:
      - Multi-agent research works because independent agents search different facets in
        parallel with isolated contexts.
      - The benefit is broader information-space coverage.
      - Costs are much higher than chat/single-agent modes.
      - System architecture, tool design, and prompt engineering are critical.
    - Direct relevance to pi-workflow:
      - `deep-research` should be framed as coverage-first and cost-aware.
      - Fanout should be bounded by depth/importance; default breadth should not be excessive.

12. **Claude: How and when to use subagents in Claude Code**
    - URL: https://claude.com/blog/subagents-in-claude-code
    - Main takeaways from search/fetch context:
      - Subagents are isolated context windows.
      - Use them for tangents, large searches/log/file reads, parallelizable work, and repeated
        specialist tasks.
      - Avoid them when the overhead is not worth it.
    - Direct relevance to pi-workflow:
      - Workflows should use subagents to isolate noisy context, not merely to imitate human
        job titles.

13. **LangChain/LangGraph and community articles on supervisor/swarm/pipeline patterns**
    - URLs searched:
      - https://docs.langchain.com/oss/python/langgraph/workflows-agents
      - community articles on supervisor vs swarm patterns
    - Main takeaways:
      - Supervisor patterns fit ordered execution, dynamic routing, conflict resolution.
      - Swarm/peer handoffs fit more independent workloads with local routing.
      - Orchestration pattern must match task interdependency.
    - Direct relevance to pi-workflow:
      - Current bundled workflows are mostly supervisor/stage pipelines, which is good for
        predictable pre-release UX.
      - They should not pretend to be free-form team systems.

14. **Parloa: How to A/B Test AI Agents With a Bayesian Model**
    - URL: https://www.parloa.com/labs/research/ai-agent-testing/
    - Main takeaways:
      - Agent eval should account for uncertainty and scenario groups.
      - Hierarchical Bayesian models can combine binary checks and graded LLM-judge scores.
      - Partial pooling reduces false positives caused by scenario variation.
      - Same-agent A/A validation is useful to detect false positives.
    - Direct relevance to pi-workflow:
      - Local evidence should remain diagnostic unless repeated/scenario-aware.
      - Task-class grouping is not cosmetic; it is needed to avoid overconfident aggregate
        conclusions.

15. **LLM-as-judge position-bias papers**
    - URLs:
      - https://arxiv.org/pdf/2602.02219
      - https://arxiv.org/html/2604.23178
    - Main takeaways:
      - Judges show position/order/style biases.
      - Balanced permutation of score options can expose and reduce position bias.
      - Single-pass LLM judge scores should be treated cautiously.
    - Direct relevance to pi-workflow:
      - Tiny score differences at the one-rubric-point threshold should be ties.
      - Future runner improvements could rescore with rubric option permutations.

## Workflow-positive drivers

Use workflow/subagents when one or more of these are true and the workflow protocol directly
addresses the driver.

- `high-depth`: many sequential reasoning/problem-solving steps; single-agent errors can
  compound.
- `high-breadth`: many independent perspectives, sources, domains, or alternatives must be
  explored.
- `parallelizable-branches`: branches can run independently with little shared state.
- `context-isolation`: subtasks generate large/noisy context but only distilled summaries are
  needed upstream.
- `checkable-output`: outputs can be tested, validated, schema-checked, source-checked, or
  compared against seeded defects.
- `verification-gate`: a separate verifier can inspect artifacts without needing full internal
  history.
- `tool-specialization`: the global tool set is large/confusing, but each role needs a small,
  clear tool subset.
- `domain-specialization`: domain boundaries are clear and routing decisions are reliable.
- `clean-interface-boundaries`: work partitions have explicit contracts and low coupling.
- `state/artifact-preservation`: intermediate files, evidence packets, logs, or structured
  results reduce handoff loss.
- `recovery-locality`: failures can be retried or corrected in one stage without corrupting the
  final answer.

## Plain-positive / workflow-negative drivers

Prefer plain single Pi when these dominate.

- `low-depth`: the task fits in one short reasoning chain.
- `low-breadth`: no meaningful independent coverage benefit exists.
- `single-synthesis`: one coherent integrated judgment matters more than branch coverage.
- `straight-line-planning`: the task is to write a clear plan from known information, not to
  discover or verify many unknowns.
- `tight-coupling`: subtasks must constantly share context or decisions.
- `ambiguous-routing`: it is unclear which specialist should handle the request.
- `handoff-loss-risk`: compressing intermediate state is likely to lose nuance or constraints.
- `coordination-overhead`: extra prompts, agents, summaries, and stage transitions cost more
  than they add.
- `verbosity-risk`: debate/panel workflows may produce more text but less decisive output.
- `compute-not-structure-confound`: a workflow may appear better only because it spends more
  calls/tokens.

## Proposed A/B task classes

The class should be descriptive, but interpretation should rely on `drivers[]` and
`riskFactors[]` because real tasks often combine multiple forces.

### Workflow-favorable classes

1. `iterative-refinement`
   - Example: draft -> critique -> revise -> final.
   - Drivers: `high-depth`, `checkable-output`, `verification-gate`.
   - Example pi workflow: `revise-loop`.

2. `verification-heavy-review`
   - Example: seeded defect review, compliance checks, schema/test validation.
   - Drivers: `checkable-output`, `verification-gate`, `context-isolation`.
   - Example pi workflow: `deep-review` when evidence is concrete.

3. `coverage-diverse-research`
   - Example: broad research requiring multiple source categories and caveats.
   - Drivers: `high-breadth`, `parallelizable-branches`, `context-isolation`.
   - Example pi workflow: `deep-research`.

4. `long-horizon-tool-use`
   - Example: multi-step investigation with files/web/tools and evidence preservation.
   - Drivers: `high-depth`, `state/artifact-preservation`, `recovery-locality`.
   - Related evidence: GAIA Level 2/3 runtime workflow results in BenchAgent.

5. `clean-partition-implementation`
   - Example: independent components with clear API/file boundaries.
   - Drivers: `parallelizable-branches`, `clean-interface-boundaries`, `tool-specialization`.
   - Caveat: tightly coupled feature work does not qualify.

### Plain-favorable classes

1. `single-synthesis-decision`
   - Example: architecture or product tradeoff memo.
   - Drivers: `single-synthesis`, `handoff-loss-risk`, `verbosity-risk`.
   - Example local task: `decision-microservices-monolith`.

2. `straight-line-planning`
   - Example: migration or implementation plan when enough context is already present.
   - Drivers: `straight-line-planning`, `coordination-overhead`.
   - Example local task: `migration-plan` in the current suite.

3. `small-contained-task`
   - Example: small bug explanation, simple API answer, concise doc edit.
   - Drivers: `low-depth`, `low-breadth`, `coordination-overhead`.

4. `tightly-coupled-work`
   - Example: one feature's planning, coding, and tests where all steps share state.
   - Drivers: `tight-coupling`, `handoff-loss-risk`.
   - Anthropic warning: splitting by job title can create a telephone game.

5. `ambiguous-specialist-routing`
   - Example: unclear owner/domain where specialist prompts may bias the work.
   - Drivers: `ambiguous-routing`, `domain-confusion`.

## Applying the taxonomy to the current local suite

| Task | Proposed class | Expected advantage | Why | Observed/corrected interpretation |
|---|---|---|---|---|
| `research-agent-evals` | `coverage-diverse-research` | workflow or parallel fanout | Multiple methodology/source/risk angles can be researched independently. | Near-tie/uncertain; result depends on corrected tie logic and human spot-check. |
| `review-seeded-safety-diff` | `verification-heavy-review` | workflow or tie | Seeded defects reward evidence-backed independent review and verification. | Objective tie: both found 3/3 seeded issues; blind score needs rejudge after normalizer fix. |
| `migration-plan` | `straight-line-planning` | plain | The suite prompt asks for a plan, not actual multi-step migration execution. | Plain win; workflow likely over-expanded inventory/planning. |
| `decision-microservices-monolith` | `single-synthesis-decision` | plain | Coherent executive judgment matters more than staged debate verbosity. | Plain win; debate workflow needs redesign if kept. |
| `revise-json-extraction-proposal` | `iterative-refinement` | workflow | Explicit draft/evaluate/revise structure maps directly to task. | Workflow win after completed rejudge. |

## Implications for current bundled workflows

### `deep-research`

- Fits: `coverage-diverse-research`, `context-isolation`, `parallelizable-branches`.
- Risks:
  - Over-fanout can erase cost/quality benefit.
  - Breadth effects saturate; depth/verification quality may matter more than more questions.
- Current state:
  - Has depth caps (`quick`, `standard`, `max`) and claim verification.
  - This is aligned with research guidance.
  - It should keep default fanout conservative and make cost/depth explicit.

### `deep-review`

- Fits: `verification-heavy-review`, `checkable-output`, `verification-gate`.
- Risks:
  - Verifier/deil-advocate stages can false-accept or rubber-stamp if criteria are vague.
  - Review lenses must inspect evidence, not just restate reviewer claims.
- Current state:
  - Triage selects lenses, reviewers inspect evidence, devil-advocate attempts refutation,
    final report treats claims as claims.
  - This is mostly aligned.
  - Needs strong concrete criteria in fixtures/tasks; seeded answer keys are valuable.

### `revise-loop`

- Fits: `iterative-refinement`.
- Risks:
  - Can be too slow or verbose.
  - More iterations are not automatically better.
- Current state:
  - Hard one-revision cap is aligned with cost-control guidance.
  - Good candidate for positive workflow evidence.

### `decision-debate`

- Intended fit: single decision stress-test.
- Risk:
  - This is exactly where plain may be stronger: `single-synthesis`, `handoff-loss-risk`,
    `verbosity-risk`.
  - Debate only helps if the task's error mode is checkable proposals/counterarguments,
    not if final coherent judgment dominates.
- Current state:
  - Local eval suggests it underperforms plain.
  - It should be reframed as a specialized stress-test workflow, not a general decision
    workflow, or redesigned to produce crisper synthesis.

### `migration`

- Intended fit: high-depth planning for large ports.
- Risk:
  - The current eval task was straight-line planning, not actual migration execution.
  - Inventory fanout may add overhead and diffuse the final plan.
- Current state:
  - It has inventory/normalize/plan-item structure and caps.
  - For real large migrations, this can fit `high-depth`/`state-preservation`.
  - For a request that only needs a concise plan, plain may be better.

### `implement`

- Intended fit: bounded implementation with validation/review gates.
- Risk:
  - Anthropic warns against splitting one tightly coupled feature by job type because it
    creates handoff loss.
  - The workflow uses planning -> validation baseline -> foreach implementation -> review.
- Current state:
  - It partially mitigates risk by slicing into independently reviewable work items and
    using managed worktrees.
  - It is aligned only when slices are genuinely independent and bounded.
  - It is risky for tightly coupled one-feature work where one agent should preserve context.

### `best-of-n-fix`

- Fits: uncertain fixes where alternatives can be explored independently.
- Risks:
  - Very expensive.
  - If the fix is obvious, it is pure coordination/compute overhead.
- Current state:
  - Prompt already warns that `implement` may be more appropriate when alternatives are not
    genuinely different.
  - This is aligned with task-fit guidance.

## Implemented runner metadata shape

The runner should not only record which arm won. It should record what task hypothesis was
being tested. Proposed task config metadata:

```json
"evaluationHypothesis": {
  "expectedAdvantage": "workflow",
  "taskClass": "verification-heavy-review",
  "drivers": ["checkable-output", "verification-gate", "context-isolation"],
  "riskFactors": ["coordination-overhead", "verifier-false-accept"],
  "reason": "Seeded defects should reward evidence-backed independent review and verification."
}
```

For a plain-favorable task:

```json
"evaluationHypothesis": {
  "expectedAdvantage": "plain",
  "taskClass": "single-synthesis-decision",
  "drivers": ["single-synthesis", "low-parallelism", "high-coherence"],
  "riskFactors": ["handoff-loss-risk", "verbosity-risk"],
  "reason": "The task requires coherent executive judgment more than branch coverage."
}
```

Suggested enum values:

```text
expectedAdvantage: workflow | plain | uncertain | tie

taskClass:
  iterative-refinement
  verification-heavy-review
  coverage-diverse-research
  long-horizon-tool-use
  clean-partition-implementation
  single-synthesis-decision
  straight-line-planning
  small-contained-task
  tightly-coupled-work
  ambiguous-specialist-routing

drivers:
  high-depth
  high-breadth
  parallelizable-branches
  context-isolation
  checkable-output
  verification-gate
  tool-specialization
  domain-specialization
  clean-interface-boundaries
  state/artifact-preservation
  recovery-locality
  low-depth
  low-breadth
  single-synthesis
  straight-line-planning
  tight-coupling
  ambiguous-routing
  handoff-loss-risk
  coordination-overhead
  verbosity-risk
  compute-not-structure-confound
```

## How reports use the metadata

The runner report now adds a compact task-fit hypothesis summary plus per-task interpretation lines:

```text
Hypothesis: expected workflow advantage
Class: verification-heavy-review
Drivers: checkable-output, verification-gate
Risks: coordination-overhead, verifier-false-accept
Outcome: objective tie; both arms found 3/3 seeded issues
Interpretation: workflow did not beat a strong plain baseline on this fixture, but the task
class remains workflow-favorable for harder/less obvious seeded defects.
```

Aggregate reporting should group by expected advantage and class:

```text
workflow-expected tasks: X wins / Y ties / Z losses
plain-expected tasks: X wins / Y ties / Z losses
uncertain tasks: ...
```

This prevents a misleading global claim and lets the suite test whether our own task-fit
hypotheses are calibrated.

## Open questions

1. Should `decision-debate` remain bundled, or be repositioned as a niche stress-test workflow?
2. Should `migration` have a quick/standard/max mode like `deep-research` to avoid over-fanout
   on straight-line planning prompts?
3. Should `implement` explicitly detect tightly-coupled work and recommend a single-agent path?
4. Should eval runner add a compute-matched plain arm before making any public workflow-lift
   claim?
5. Done: runner reports now group outcomes by `evaluationHypothesis.expectedAdvantage` and task class before detailed winner analysis.
