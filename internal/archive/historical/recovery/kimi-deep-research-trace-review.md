> Historical archive. Non-authoritative. Preserved for recovery context only.
> Current public terminology is workflow / workflow spec / workflow file / workflow run.

# Deep-Research Workflow Review

**File reviewed:** `/Users/toby/pi/pi-workflow/docs/deep-research-run-trace-20260607.md`  
**Workflow definition:** `/Users/toby/pi/pi-workflow/workworkflows/deep-research.json`

---

## Summary

The deep-research workflow produces high-quality, source-backed findings, but its mechanisms are **locally optimized for research coverage rather than aligned with the parent session's decision objective**. The trace reveals 58 tasks (7 research questions → ~88 raw claims → 48 normalized claims → 48 verification tasks → 1 synthesis) producing an encyclopedic final report. The workflow behaves like an autonomous research assistant, not a **decision-support system**. Key gaps: no explicit decision context drives question planning; "selective verification" is actually exhaustive annotation; subagent risk/impact judgments are plausible-sounding but untethered from the parent's actual tradeoffs; and the final synthesis boundary is a data dump rather than a decision brief.

---

## 1. Question Planning: Topic-Oriented, Not Decision-Oriented

### Finding: Missing requirement-to-question traceability
The plan stage generates topic-based research questions (blind evaluation, seeded defects, contamination, LLM-as-judge, reproducibility, cost-quality, A/B/C design). Each has `whyItMatters` explaining relevance to pi-workflow, but **none are framed as decision-forcing questions tied to an explicit parent decision**.

**Concrete example:** Question `blind-eval` asks *"What established methodologies exist for blind evaluation…?"* This is a literature survey. A decision-oriented framing would be: *"Given pi-workflow must compare multi-agent vs single-agent outputs, should we use pairwise or pointwise evaluation, and what debiasing controls are mandatory?"*

The trace's `coverageGaps` (e.g., *"No directly validated double-blind protocol specifically for multi-agent versus single-agent coding evaluation"*) are research findings, not evidence that the question plan failed to cover a decision need.

### What `covers/taskCoverage` should be
The current JSON has no structured coverage mapping. Keyword tags would be too shallow. A **decision-requirement matrix** or **information-needs graph** would be better:

```json
{
  "decisions": [
    {
      "id": "D1",
      "question": "Should pi-workflow use pairwise or pointwise evaluation?",
      "informationNeeds": ["blind-eval", "llm-judge"],
      "acceptanceCriteria": "Evidence must come from code-evaluation studies, not NLG"
    }
  ]
}
```

This would let the parent see which questions serve which decision, and let the workflow detect when a decision lacks coverage.

**Severity: Major** — Questions may overlap (both `blind-eval` and `llm-judge` touch evaluation bias) while missing decision-critical angles (e.g., *"What is the minimum viable evaluation protocol given our budget?"*).

---

## 2. Raw Claim Expansion: Budget Explosion Before Control

### Finding: Budget cap is at normalize stage, but claims explode earlier
Item-002 (seeded defects) produced **20 raw claims**. Item-001 produced 10. Item-003 produced 12. By the time the normalize stage applies its "standard target 24 / hard cap 48," the research stage has already consumed compute on ~88 claims. The normalize stage merely down-selects; it does not prevent over-generation.

**Concrete example:** Item-002's 20th claim was *"Sharing execution environments across tasks… reduces storage overhead by ~500x"* — a tangential claim about infrastructure optimization, not evaluation design. It was presumably discarded at normalize, but only after the research subagent spent tokens generating it.

### Where budget should be controlled
Budget control should be **upstream**:
- **Per-question claim cap:** The research prompt should include a max-claims directive (e.g., *"Return at most 8 atomic claims; prioritize those most likely to change a design decision"*).
- **Plan-stage estimated budget:** The planner could estimate total tasks based on question count × expected claims per question, and warn if it exceeds the depth budget.
- **Incremental research:** Rather than fanning out all questions in parallel, research the highest-information-need questions first, then decide whether remaining questions are worth the marginal cost.

**Severity: Major** — The current design risks exponential cost growth on low-value claims before any culling happens.

---

## 3. Subagent Risk/Impact Judgment: Plausible but Untethered

### Finding: `priority` and `riskIfWrong` are generic, not decision-calibrated
The normalize stage asks the subagent to assign `priority`, `riskIfWrong`, `sourceQuality`, and `reasonToVerify`. These sound good but are **locally plausible rather than decision-relevant**.

**Concrete examples from the trace:**
- *"Position-swapping is the standard control for position bias"* → `riskIfWrong: "Pairwise comparisons would be confounded by presentation order, invalidating rankings."` But if the parent already decided to use pointwise evaluation (per the report's own recommendation), this risk is irrelevant.
- *"Turn-control strategies can reduce agent costs 24–68%"* → `priority: medium`, `riskIfWrong: "Pi-workflow might miss practical methods for keeping multi-agent evaluation costs bounded."` But if the parent's primary decision is evaluation validity, not cost, this is low-decision-value information.

### Alternatives that would align better with parent decisions
1. **Parent-decision relevance:** Each claim should map to an explicit parent decision branch and state whether it confirms, challenges, or is neutral to that branch.
2. **Uncertainty reduction:** Prioritize claims that resolve high-uncertainty decision branches. A claim with overwhelming prior consensus is low value even if `riskIfWrong` sounds scary.
3. **Value-of-information:** Estimate how much the decision would change if the claim were wrong. This requires the subagent to know the decision alternatives, which it currently does not.
4. **Explicit decision questions (recommended):** Replace open research questions with decision-forcing questions. Instead of *"What is known about benchmark contamination?"* → *"Does contamination risk invalidate using SWE-bench for our A/B/C comparison, and what mitigation is required?"*

**Severity: Major** — The subagent cannot reliably judge risk/impact without knowing what decision the parent is trying to make.

---

## 4. Verification Selection Design: Exhaustive Annotation, Not Selection

### Finding: "Selective verification" verifies everything
The trace shows **48 claims entered `claimsForVerification` and all 48 were verified** (one verify task per claim). There is no actual selection mechanism. The verification stage functions as **claim annotation** (assigning `verified` / `partially_supported` / `unsupported` / `conflicting`) rather than **quality gating**.

**Concrete examples of verification not affecting downstream flow:**
- Item-003 (pointwise vs pairwise): `status: partially_supported`, `confidence: medium` — evidence is from NLG, not code. It flows into the final report with a caveat.
- Item-006 (minority-veto ensembles): `status: partially_supported`, `confidence: medium` — claim conflates two methods with different results. It flows into the final report.
- Item-025 (surface string matching): `status: partially_supported`, `confidence: medium` — source contradicts the claimed solution (AST similarity). It flows into the final report.
- Item-046 (A/B test sample size): `status: partially_supported`, `confidence: medium-low` — independent sources directly contradict the claim. It **still flows into the final report**.

The final report contains 48 `verifiedClaims` including all partially_supported items. The only distinction is a `caveat` field.

### What verification should do
- **Gate claims by status:** `unsupported` or `conflicting` claims should be excluded from `verifiedClaims` and moved to `rejectedClaims` or `needsParentJudgment`.
- **Escalate weak high-priority claims:** A `partially_supported` claim tagged as decision-critical should trigger a follow-up research task, not pass through silently.
- **Use verification to prune, not just label:** If 48 claims become 15 verified + 10 partially_supported-with-caveats + 23 rejected, the final report becomes a decision aid instead of a bibliography.

**Severity: Critical** — Verification that does not filter is just expensive annotation. The parent receives the same claim volume regardless of evidence quality.

---

## 5. Final Synthesis Boundary: Encyclopedia vs. Decision Brief

### Finding: Final report is too large to support decision-making
The `finalReport` JSON contains:
- 1 summary paragraph
- 48 verifiedClaims (many with caveats)
- ~25 practical recommendation bullets across 7 areas
- 5 caveats/risks
- 4 remaining gaps

This is **research output**, not a **decision brief**. The parent must still read and synthesize across all 48 claims to decide what to do.

**Concrete example:** The summary says *"Current literature provides no off-the-shelf double-blind protocol… but validated bias controls can be adapted"* and lists 7 recommendations. But it does **not** say:
- *"Decision: Use pointwise evaluation, not pairwise, because…"*
- *"Decision: Do NOT rely solely on LLM-as-judge for A/B/C decisions because agreeableness bias has TNR < 25%"*
- *"Blocking gap: We cannot validate contamination mitigation for your local task set without knowing what tasks you plan to use."*

### Where the boundary should be
The workflow should produce two distinct outputs:
1. **Decision Brief (for parent):** 1-page max. States the decision question, the recommended choice, the 3–5 claims that most strongly support it, the 1–2 blocking gaps that could invalidate it, and what the parent must decide.
2. **Evidence Packet (for reference):** The full 48-claim dataset, available if the parent wants to drill down.

The workflow currently produces only #2 and labels it a report.

**Severity: Major** — The parent Pi session's goal is to make a better decision, not to receive a literature review.

---

## Prioritized Recommendations

| Priority | Recommendation | Rationale |
|---|---|---|
| **P1 (Critical)** | Make verification a **quality gate**, not annotation. Reject `unsupported`/`conflicting` claims from the final report. Escalate `partially_supported` claims that are decision-critical for parent judgment. | Without filtering, verification adds cost without reducing parent cognitive load. |
| **P1 (Critical)** | **Add explicit decision context** to the plan stage. Require the parent (or parent session prompt) to state the decision question and alternatives. Frame research questions as decision-forcing, not topic surveys. | Current topic-oriented questions optimize for coverage, not decision quality. |
| **P2 (Major)** | **Split final output** into a concise Decision Brief (≤1 page, recommendation + key evidence + blocking gaps) and a separate Evidence Packet (full claims). The workflow boundary should end at the Decision Brief. | Parent needs actionable synthesis, not an encyclopedia. |
| **P2 (Major)** | **Move budget control upstream** to the research-questions stage. Cap raw claims per question (e.g., max 8) and estimate total task count at plan time. | Prevents compute explosion on low-value claims before normalize can cull them. |
| **P2 (Major)** | Replace `riskIfWrong` with **decision-relevance scoring**. Each claim should state which parent decision it affects and whether it confirms, challenges, or is neutral to each alternative. | Subagent-generated risk assessments are plausible but not decision-calibrated. |
| **P3 (Minor)** | Add a **decision-requirement coverage matrix** to the plan output, mapping research questions to parent decision branches. Flag uncovered decision branches as `coverageGaps`. | Prevents questions that overlap on easy topics while missing hard decision angles. |
| **P3 (Minor)** | Use the `verificationRubric` from plan stage as **structured constraints** in the verify prompt (e.g., "Claims about reliability require human-agreement baselines per the rubric"). Currently it is informational only. | Makes the rubric an active quality control, not just documentation. |

---

## Ideas That Sound Good But May Not Work

| Idea | Why It Sounds Good | Why It May Not Work |
|---|---|---|
| **High-risk/high-impact prioritization by subagent** | Seems to focus effort on what matters most | Subagent lacks parent decision context; `riskIfWrong` becomes generic, dramatic-sounding boilerplate |
| **Selective verification of only high-priority claims** | Saves budget on low-value claims | In the trace, ALL 48 claims were verified. Without a pre-verification filter, "selective" is just a cap on total claims, not intelligent selection |
| **Evidence-packet final report** | Sounds rigorous and comprehensive | Produces information overload; parent still has to do the synthesis work the workflow was supposed to do |
| **Depth policy (quick/standard/max)** | Gives parent control over tradeoff | Implemented as crude numeric caps (questions, claims) without quality-weighted selection; max just runs more of the same pattern |
| **Subagent-generated `coverageGaps`** | Appears to self-audit completeness | In the trace, gaps were research findings ("no published double-blind protocol") rather than plan deficiencies ("we failed to cover cost-validity tradeoffs") |

---

## Assumptions / Unknowns

- **What is the parent session's actual decision?** The trace shows the eval task was `research-agent-evals`, but the parent Pi session's specific decision context (e.g., "Should we invest in multi-agent evaluation?" vs. "How do we design the next A/B test?") is not captured in the workflow input. Without this, all judgment about decision-alignment is inferential.
- **Does the parent have capacity to read 48 claims?** The review assumes the parent wants a concise decision brief, but if the parent is a research team that wants raw evidence, the current output format may be appropriate.
- **Can the workflow access parent decision state?** If the workflow is intentionally isolated from parent context for safety/reproducibility, then decision-relevance scoring may require an explicit input field rather than inference.
