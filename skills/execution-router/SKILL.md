---
name: execution-router
description: Decide whether a task should be handled by a strong single agent, an existing pi-workflow workflow, a targeted subagent/verifier, or a new/extended workflow. Use when asked to choose an execution mode, decide if workflow/subagents are appropriate, or sanity-check task decomposition before implementation/evaluation. Produces a concrete action, scope inventory, score ledger, risks, controls, and escalation/de-escalation triggers.
---

# Execution Router

Use this skill to decide the execution architecture for a task before doing substantive work.

Core principle:

> Start with the simplest architecture that can meet the final-output quality bar. Escalate only when the task structure, evidence needs, context pressure, verification needs, or safety constraints justify the coordination cost.

Do **not** treat workflow/multi-agent as inherently better. Treat it as a tool that must earn its complexity.

## When to use

Use this skill when the user asks questions such as:

- “Is workflow the right approach for this task?”
- “Can this be handled by a single agent?”
- “Should I use a subagent?”
- “Is multi-agent execution appropriate?”
- “Check the execution approach first.”
- “Review whether this approach fits an A/B test or benchmark design.”

Also use it before large/risky tasks where the architecture choice itself affects cost, quality, or safety.

Skip for trivial one-step edits, direct factual answers, or cases where the user explicitly chose the execution mode and only wants implementation.

## Scope inventory first

Before scoring, identify the minimum scope facts that affect routing:

- **Target**: whole repo, current diff, staged diff, named files, branch/range, issue/spec, or external sources.
- **Final artifact**: answer, patch, review report, research report, benchmark, test evidence, design doc, etc.
- **Success metric**: correctness, recall, precision/no false positives, tests pass, evidence coverage, ship readiness, etc.
- **Allowed side effects**: read-only, local edits, tests, network search, external mutation, deployment, tickets/messages.
- **Exclusions**: generated files, runtime state, scratch dirs, hidden gold/answer keys, vendored deps, secrets, private data.
- **Constraints**: deadline, cost/latency, model/provider, no workflow/subagents, privacy/security, required validation.

For repository reviews, inspect or ask about scope before recommending a broad run: current working tree vs staged diff vs a branch comparison; whether untracked files, runtime state directories, generated artifacts, eval scratch data, or private answer keys are in or out of scope.

If the scope, final artifact, or success metric is unclear and would change the architecture, ask at most 3 clarifying questions before recommending a complex route.

## Evidence probes and anchors

Before scoring, collect cheap objective signals when tools/context make them available. Use these as anchors, not hard gates:

- **Available routes**: discover existing workflows when the user asks to choose a route or when a workflow may fit.
- **Change breadth**: changed file count, changed domain count, diff size, and whether files share ownership/state.
- **Context pressure**: number of source families, amount of generated/runtime material to exclude, and whether one agent can keep the relevant facts coherent.
- **Validation readiness**: known test/check commands, workflow validation status, required agents, and whether evidence can be produced without mutating state.
- **Risk signals**: security/concurrency/state/API changes, private/eval data exposure risk, irreversible side effects, or high false-positive domains.

Rough anchors for repository work:

- 0–3 changed files or one domain usually favors single-agent unless evidence breadth or auditability matters.
- 4–10 changed files, 2–3 domains, or medium diff size usually favors single-agent plus targeted verifier, or an existing workflow for read-only review.
- 11+ changed files, 4+ domains, large diff size, or high coverage/recall needs increase workflow/subagent benefit.
- High same-file/shared-state coupling, edit conflicts, or unclear ownership increases multi-agent penalty.

These anchors calibrate scores only. Do not force a workflow solely because a numeric threshold was crossed.

## Required output shape

Return a concise routing memo with these fields:

- **Recommendation**: `single-agent`, `use existing workflow`, `add targeted subagent/verifier`, `extend existing workflow`, `create new workflow`, or `needs clarification`.
- **Concrete action**: `do it directly`, `validate/run workflow:<name>`, `add stage to workflow:<name>`, `create workflow:<name>`, `add targeted subagent/verifier`, or `ask clarification`.
- **Confidence and decision**: high/medium/low plus proceed/proceed-with-constraints/do-not-escalate/ask-clarification.
- **Scope assumptions**: what is in scope and out of scope.
- **Evidence used**: cheap probes run, skipped, or still needed.
- **Existing workflow fit**: brief yes/no for bundled workflows and any discovered project-local workflows that appear relevant.
- **Scores**: single sufficiency `/10`, workflow fit `/6`, multi-agent benefit `/18`, multi-agent penalty `/18`, with enough notes to justify the totals.
- **Why / minimum viable approach / required controls / validation plan**.
- **If nothing existing fits**: proposed workflow or stage name, target path, stage graph, inputs/outputs, validation command, run command, and promotion criteria.

If information is missing, ask at most 3 clarifying questions. If enough is known, state assumptions and proceed with a recommendation.

## Project workflow routing

Discover available workflows when the user asks to choose a workflow or when project-local workflows may matter. Consider bundled workflows plus relevant project-local workflows. Bundled defaults:

| Workflow | Use when | Do not use when |
|---|---|---|
| `deep-research` | Broad source gathering, claim extraction, cross-source synthesis, evidence/citation-heavy research. | Small factual answers, code edits, or tasks with no need for source-family fanout/reducer. |
| `deep-review` | General code-review style defect discovery where recall, grounded findings, dedup, and verifier/refuter stages matter. | Direct bug fixing, tiny diffs where single-agent can review coherently, or no-issue checks where FP risk dominates and workflow overhead is unjustified. |
| `impact-review` | Change impact analysis: what files/features/users/tests may be affected by a patch/design/change. | General research, implementation, or defect discovery without impact mapping. |
| `spec-review` | Spec/requirements conformance: requirement extraction, implementation/test mapping, gap report. | Open-ended research or ordinary code review not anchored to a spec. |

Routing rules:

1. If an existing workflow fits, recommend `run workflow:<name>` and state the exact task packet it should receive.
2. If an existing workflow almost fits but lacks a verifier/refuter/reducer/gate, recommend `add stage to workflow:<name>` and describe the smallest stage to add.
3. If no workflow fits but the process is repeatable with clear stages, recommend `create workflow:<name>` with proposed stages, file location, validation command, and a sample `/workflow run` command.
4. If only one bounded check or bulk read is needed, recommend `add targeted subagent/verifier`, not a full workflow.
5. If the task is small, linear, or edit-conflict-prone, recommend `single-agent` and explicitly say not to use workflow.

Do not stop at abstract labels like “deterministic workflow.” Always map it to one of:

```text
do it directly
validate/run workflow:<existing-name>
add stage to workflow:<existing-name>
create workflow:<proposed-name>
add targeted subagent/verifier
ask clarification
```

## Workflow readiness gate

Before recommending an existing workflow run, check or explicitly plan to check:

- The workflow exists and is unambiguous.
- `/workflow validate <name-or-path>` should be run before launch; if validation has not run yet, the concrete action is `validate/run workflow:<name>`.
- Required agents are available or the missing agent is called out as a blocker.
- The workflow read/write policy matches allowed side effects.
- Tool ceilings are sufficient and do not exceed the agent authority ceiling.
- The runtime task packet states scope, exclusions, success metric, and expected final artifact.

If any readiness item is unknown, keep confidence below high and make validation or clarification the next action.

## New workflow recommendation protocol

When recommending `create workflow:<name>`, include a concrete creation-and-use packet. Do not merely say “make a workflow.”

### 1. Choose the target location

- For a local experiment or scratch workflow: `.pi/workflows/<name>.json`.
  - This is ignored by git and is appropriate before task fit is validated.
- For a tracked/bundled workflow after explicit approval: `workflows/<name>/spec.json`.
  - Also update `workflows/README.md` and `docs/usage.md` if it becomes user-facing.
  - Add tests only when the workflow is intended to be maintained as a bundled starter.

### 2. Provide the proposed stage graph

List stages in execution order or DAG form. For each stage include:

```text
id:
type: single | foreach | reduce | dag | support helper
depends/from:
purpose:
agent/tools/readOnly:
input:
output/control fields:
validation/gate:
```

Prefer the smallest useful workflow. If one verifier stage is enough, recommend adding a targeted verifier instead of creating a full workflow.

### 3. Provide contracts and artifacts

Specify:

- Runtime task packet expected from the user.
- Required artifacts per stage: `<control>`, `<analysis>`, `<refs>` when using artifact graph outputs.
- Control schema files if needed: `workflows/<name>/schemas/<stage>-control.schema.json`.
- Support helper files if needed: `workflows/<name>/helpers/<helper>.mjs`.
- Reducer/dedup/provenance rules when fan-out exists.

### 4. Provide exact validation and run commands

Include commands like:

```text
/workflow validate <name-or-path>
/workflow run <name-or-path> "<concrete runtime task>"
/workflow wait <run-id> 600000
/workflow show <run-id>
```

For terminal/package validation, mention project checks only when relevant:

```bash
npm test
npm run typecheck
npm run e2e
```

Do not require broad tests for a scratch `.pi/workflows/<name>.json` unless code/helpers were changed.

### 5. Provide promotion criteria

State what evidence would justify keeping/promoting the workflow:

- It beats strong single-agent or self-check on final-output quality.
- It does not increase false positives/duplicates beyond the allowed threshold.
- It has clear invalid/quarantine behavior.
- It has bounded cost/latency.
- It is reused enough to justify maintenance.

If those criteria are not met, recommend de-escalating to single-agent or targeted verifier.

## Step 0 — Normalize the routing problem

Before scoring, turn the user's request into a routing packet:

1. **Scope**: target files/repos/diffs/sources, inclusions, exclusions, and ownership boundaries.
2. **Final artifact**: answer, code patch, PR review, research report, benchmark result, test evidence, design doc, etc.
3. **Primary quality metric**: correctness, recall/precision, tests pass, evidence coverage, no false positives, user usefulness, safety, etc.
4. **Allowed side effects**: read-only, local file edits, tests, network search, external mutations, deployment, tickets, messages, etc.
5. **Known constraints**: deadline, cost, latency, model/provider, no TODO/no subagents/no workflow, hidden gold, privacy, security.

If the final artifact, success metric, or side-effect boundary is unclear, ask before recommending a complex architecture.

## Step 1 — Hard stops and safety gates

Apply these before scoring.

### Do not use full multi-agent yet if any are true

- No strong single-agent baseline exists and the task is not obviously impossible for single-agent.
- No reducer/dedup/provenance plan exists for fan-out results.
- No verifier/refuter/evidence gate exists for high-FP domains like code review, security, or research synthesis.
- Candidate agents would see private gold, answer keys, hidden tests, judge prompts, or scoring outputs.
- Multiple agents would edit the same files/state without ownership boundaries or worktree isolation.
- Side effects are irreversible/high-impact and there is no approval/sandbox/audit plan.

Recommendation should be `single-agent`, `deterministic workflow`, or `targeted subagent/verifier` until the missing gate exists.

### Prefer deterministic workflow over agentic/multi-agent if

- Steps, branches, retries, and validation gates are known in advance.
- The task needs reproducibility more than open-ended exploration.
- Human approval/checkpoints are required.

### Prefer single-agent if

- The task needs one coherent owner with shared context.
- Same-file or same-state dependencies are high.
- The task is small/linear and context fits.
- The main risk is false positives or over-reporting.

## Score ledger discipline

Always compute scores from observable facts or explicit assumptions. Do not invent certainty to make a route look better.

- Mark unknown items as `unknown` in the reasoning; unknowns lower confidence.
- Include total scores plus the top 1–3 drivers for and against the recommendation.
- Include itemized score reasons when the user asks for detailed scoring, confidence is low, scores are near a decision boundary, or the route is risky.
- If a recommendation depends on a threshold, show the threshold in the explanation.

## Step 2 — Score single-agent sufficiency

Score 1 point for each “yes” (0–10):

| ID | Question |
|---|---|
| S1 | Needed context fits in one agent’s working context or can be retrieved on demand. |
| S2 | Task path is linear or only lightly branching. |
| S3 | One coherent owner should integrate the full context. |
| S4 | Same-file/same-state dependencies are high enough that parallelism risks conflict. |
| S5 | One agent can safely use the required tools. |
| S6 | Output schema and success criteria are clear. |
| S7 | Tests/checks/self-review are enough for validation. |
| S8 | No-issue/false-positive risk is high. |
| S9 | Subtask boundaries are ambiguous. |
| S10 | Strong single-agent baseline is likely to meet the quality bar. |

Interpretation:

- 8–10: choose `single-agent` unless a hard workflow/safety requirement exists.
- 5–7: start single-agent or deterministic workflow; only targeted delegation for bounded reading/verification.
- 0–4: workflow/subagent/multi-agent may be justified; continue scoring.

## Step 3 — Score deterministic workflow fit

Score 1 point for each “yes” (0–6):

| ID | Question |
|---|---|
| W1 | Steps are known in advance. |
| W2 | Branch conditions can be expressed as rules/classifier decisions. |
| W3 | Each step has a clear input/output contract. |
| W4 | Validation gates or retry conditions are explicit. |
| W5 | The process will be repeated or benchmarked. |
| W6 | Human approval/checkpoints/audit trail are useful. |

Interpretation:

- 4–6: choose `deterministic workflow` before multi-agent.
- 2–3: use single-agent with explicit checklist/gates, or a small workflow if repeated.
- 0–1: workflow may be unnecessary unless needed for audit/safety.

## Step 4 — Score multi-agent benefit

Score each dimension 0–3 (0–18):

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| B1 Decomposition | Not decomposable | Weak decomposition | Clear subtasks | Many independent subtasks |
| B2 Independent evidence | One source/path | Some alternatives | Multiple sources/lenses | Breadth-first search is central |
| B3 Context pressure | Small | Moderate | Large | Single context would be polluted/exceeded |
| B4 Verification need | Low | Self-check enough | Fresh verifier useful | Refuter/test/evidence gate essential |
| B5 Role/tool boundary | Same role/tools | Different role | Different tools/policies | Different permissions/ownership |
| B6 Coverage importance | Low | Moderate | High | Misses are critical |

Interpretation:

- 0–5: stay single-agent.
- 6–9: consider `targeted subagent/verifier` or deterministic workflow.
- 10–13: multi-agent candidate if penalty is low and reducer/verifier exists.
- 14–18: full multi-agent/workflow may be appropriate if controls exist.

## Step 5 — Score multi-agent penalty

Score each dimension 0–3 (0–18):

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| P1 Shared-state dependence | Independent | Mild | High | Same-file/same-state conflict likely |
| P2 Handoff loss | Low | Moderate | High | Context loss would be fatal |
| P3 Reducer/verification gap | Strong | Partial | Weak | None |
| P4 False-positive risk | Low | Moderate | High | No-issue/high-FP traps central |
| P5 Side-effect risk | Read-only | Reversible local | External/reversible | Irreversible/high-stakes |
| P6 Eval/baseline maturity | Strong hidden eval + baseline | Baseline only | Weak rubric | No eval/baseline |

Interpretation:

- 0–5: escalation is operationally safe if benefit justifies it.
- 6–10: proceed only with constraints and explicit controls.
- 11–18: do not use full multi-agent yet; reduce scope or add gates first.

Hard stop: if P3, P5, or P6 is 3, recommend against full multi-agent until fixed.

## Step 6 — Choose architecture

Use this decision table after scoring.

| Condition | Recommendation |
|---|---|
| Missing success metric, scope, or side-effect boundary that would change routing | `needs clarification` |
| Single sufficiency ≥ 8 | `single-agent`, concrete action `do it directly` |
| Existing workflow fits and readiness gate is satisfied or planned | `use existing workflow`, concrete action `validate/run workflow:<name>` |
| Workflow fit ≥ 4 and no existing workflow fits | `create new workflow`, concrete action `create workflow:<name>` with creation-and-use packet |
| Existing workflow almost fits but lacks one gate | `extend existing workflow`, concrete action `add stage to workflow:<name>` |
| Benefit 6–9 and penalty ≤ 10 | `add targeted subagent/verifier` |
| Benefit ≥ 10 and penalty ≤ 5 and reducer/verifier/eval exists | `create new workflow` or `extend existing workflow` for full multi-agent workflow |
| Benefit high but penalty high | `extend existing workflow` with verifier/reducer controls, or `add targeted subagent/verifier`; do not full fan-out yet |

Tie-breakers:

1. Prefer the simplest architecture unless the final-output quality gap is known and material.
2. If single sufficiency is ≥8, choose single-agent even when a workflow exists, unless the user explicitly needs auditability/repeatability or a workflow run.
3. For coding/bug fixing, default to single-agent plus tests unless independent hypotheses or verifier-only checks are clearly valuable.
4. For broad read-only review/research, an existing workflow can beat single-agent when workflow fit is ≥4 and scope is explicit.
5. If parallel workers would edit the same files or state, do not recommend full multi-agent; use single-agent or a verifier-only subagent.
6. If validation/readiness cannot be checked yet, make validation the next action rather than claiming the workflow is ready to run.

## Architecture patterns

### Strong single-agent

Use when one owner can read, reason, edit, and validate coherently.

Minimum controls:

- Clear success criteria.
- Bounded context/retrieval plan.
- Structured final output if needed.
- Relevant checks/tests.
- Self-review for non-trivial work.

### Deterministic workflow

Use when the process is known and repeatable.

Typical shape:

```text
classify/materialize → execute/check → validate → summarize/report
```

Minimum controls:

- Step input/output contracts.
- Validation gates.
- Retry/abort rules.
- Artifact/evidence paths.
- Human approval points if needed.

### Targeted subagent/verifier

Use when one bounded part benefits from fresh context or bulk reading.

Good assignments:

- “Read these 20 files and return only the 5 relevant facts.”
- “Verify whether this finding is source-grounded.”
- “Search for counterexamples, write evidence to a file.”

Minimum controls:

- Self-contained task packet.
- Scope and exclusions.
- Output schema/path.
- Validation responsibility.
- Parent integrates; delegate does not own final truth.

### Full multi-agent workflow

Use only when decomposition, independent evidence, verification, and reduction are all real.

Minimum controls:

- Planner/router with bounded worker count.
- Worker ownership boundaries.
- Structured handoffs.
- Reducer/dedup/provenance carry-through.
- Fresh verifier/refuter.
- Termination/budget limits.
- Final-output evaluation against strong baseline.

Avoid:

- Naive union of findings.
- Homogeneous debate as proof.
- Majority vote without source/test evidence.
- Parallel edits to same files/state.

## Domain-specific heuristics

### Code review / defect discovery

Default: single-agent for small diffs; workflow or targeted verifier for high-risk reviews.

Escalate when:

- Cross-file invariants, concurrency/state/security/API contracts are involved.
- Known issue recall matters more than speed.
- Fresh refuter can reduce false positives.

Recommended complex pattern:

```text
triage/planner → specialist reviewers → refuter/verifier → evidence checker → curator
```

Primary metrics:

- Known issue recall.
- Precision / false positive trap hit rate.
- Evidence groundedness.
- Duplicate-adjusted finding quality.
- Severity calibration.

### Coding / bug fixing

Default: single-agent + tests.

Escalate only when:

- Independent hypotheses are useful.
- Test writer/reviewer can operate without edit conflicts.
- Worktree/file ownership is clear.

Avoid parallel same-file edits.

### Research / report synthesis

Default: single-agent for narrow research.

Escalate when:

- Many source families must be covered.
- Counterevidence is important.
- Citation verification is required.
- Context is too large for one coherent pass.

Recommended pattern:

```text
planner → source-family researchers → claim normalizer → verifier/counterevidence → synthesis reducer
```

### Spec review / conformance

Workflow is often strong:

```text
requirement extraction → implementation mapping → test mapping → gap verification → final report
```

Escalate to multi-agent only for large specs with independent expert lenses.

### Security / audit

Default: scoped single-agent or deterministic threat-model workflow.

Escalate when several independent lenses matter:

```text
asset map → threat model → lens auditors → exploitability verifier → false-positive refuter → risk report
```

Never use consensus as proof of safety.

## Confidence calibration

Set confidence from three components:

1. **Completeness**: scope, final artifact, success metric, side effects, exclusions, and constraints are known.
2. **Score margin**: the recommended route is clearly ahead of plausible alternatives and not hovering near a threshold.
3. **Readiness**: required workflows/agents/tools/checks are available, or the next validation command is explicit.

Use this calibration:

- **High**: completeness is high; no hard stop applies; readiness is checked or explicitly queued; score margin is clear; the ledger has few or no unknowns.
- **Medium**: one important uncertainty remains, the top routes are close, or workflow/readiness still needs validation; recommendation includes assumptions and constraints.
- **Low**: two or more Step 0 facts are missing, a hard stop may apply, side effects are unclear, private/eval data may be exposed, or the recommendation depends on unverified workflow/agent availability.

Use low confidence with `needs clarification` when missing information could change the route. Do not use high confidence if the score ledger contains multiple unknowns.

## De-escalation triggers

Recommend a simpler approach if any happen during execution:

- Delegates need the same context repeatedly.
- Handoff summaries lose critical details.
- Duplicate findings exceed useful signal.
- Verifier cannot distinguish true/false claims.
- No final-output metric exists.
- Cost/latency grows without quality evidence.

## Escalation triggers

Escalate from single-agent to workflow/subagent if any happen:

- The single-agent misses known independent areas of the task.
- Context exceeds what can be kept high-signal.
- Validation requires a fresh/no-prior context check.
- The same structured procedure will be repeated.
- A hidden-gold/final-output evaluation shows a material gap.
