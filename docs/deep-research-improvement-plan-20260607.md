# Deep Research Workflow Improvement Plan

## Why we are doing this

`deep-research` is a bundled pi-workflow intended to do **much, detailed, accurate research**.

Recent A/B/C evidence and the trace in `docs/deep-research-run-trace-20260607.md` show that the current workflow can produce rich research, but its outputs blur several different claim states and make it hard to tell:

- what research scope was covered or missed,
- which claims are strongly supported,
- which claims are partially supported, contested, unsupported, or merely unverified,
- how much raw research breadth was explored versus how much was actually verified,
- whether the final report is accurately representing evidence strength.

The goal is **not** to make `deep-research` decide what the parent Pi session should do. The parent session remains responsible for decisions. The workflow should produce a better research artifact: broad, detailed, evidence-calibrated, and easy for the parent to inspect.

## Core goal

`deep-research` should optimize for:

1. **Much** — broad enough exploration for the selected depth mode.
2. **Detailed** — concrete claims, sources, caveats, and evidence records.
3. **Accurate** — evidence strength is clearly separated from unverified or weakly supported material.

## Non-goals

- Do not turn `deep-research` into a decision-making workflow.
- Do not make the workflow output a final product decision, recommendation, or parent-session action plan.
- Do not over-compress research into a one-page decision brief.
- Do not simply reduce raw claim generation in a way that undermines deep research.
- Do not claim workflow superiority from this change alone.

## Current behavior observed in the trace

Trace: `docs/deep-research-run-trace-20260607.md`

Observed shape:

```text
plan.main
  -> research-questions.item-001..007
  -> normalize-claims.main
  -> verify-claims.item-001..048
  -> final.main
```

For the standard-depth run:

- research questions: 7
- raw claims: approximately 88
- claims selected for verification: 48
- verification tasks: 48
- final report includes many claims, including partially supported claims, under a structure that can make evidence strength hard to scan.

The main issue is not that the workflow researched too much. The issue is that the claim lifecycle is too flat: claims move from raw research into verification/final reporting without enough durable separation between evidence states.

## Proposed direction

### 1. Add research-scope coverage tracking

Coverage tracking should prevent scope omissions without turning the workflow into a parent-decision system.

Important design constraint: scope extraction and question planning should be separated. If the same prompt invents scope items and questions at once, it can create a self-justifying plan where every generated scope item is conveniently covered. The workflow should first extract target research scope from the runtime task, then plan questions against that target scope.

Proposed plan shape:

```json
{
  "researchScope": [
    "blind evaluation methodology",
    "seeded defects / answer keys",
    "benchmark contamination",
    "LLM-as-judge reliability",
    "reproducibility metadata",
    "cost-vs-quality tradeoff"
  ],
  "researchQuestions": [
    {
      "id": "llm-judge",
      "question": "How reliable is LLM-as-judge for code evaluation?",
      "covers": ["LLM-as-judge reliability"],
      "whyItMatters": "...",
      "searchQueries": ["..."],
      "expectedSourceTypes": ["academic papers", "benchmark docs"],
      "priority": "high"
    }
  ],
  "researchScopeCoverage": [
    {
      "scopeItem": "benchmark contamination",
      "coveredBy": ["contamination"],
      "status": "covered"
    }
  ]
}
```

`covers` is not meant to be a parent-decision mapping. It is a lightweight research-scope mapping: what part of the requested research scope this question is responsible for. Use a flat string array to reduce token overhead and schema error risk.

Allowed `researchScopeCoverage.status` values:

```text
covered | partial | gap | out_of_scope
```

Prompt rule:

```text
First extract researchScope from the runtime task. Then create researchQuestions that cover those scope items. If any researchScopeCoverage item is gap, either add a research question for it or explain why it is intentionally out_of_scope.
```

Purpose: this does not magically improve research, but it should expose missed scope items earlier and make omissions visible in the final report.

### 2. Preserve broad raw discovery, but make claim lifecycle explicit

Avoid treating all claims as equivalent. Instead, preserve broad discovery while separating claim states. The research stage may use a soft per-question raw-claim target to limit verbosity, but should preserve useful overflow as unverified leads rather than silently discard it.

Proposed lifecycle:

```text
rawClaim
  -> normalizedClaim
  -> verificationCandidate | unverifiedClaim | duplicate | outOfScope | lowValue
  -> verified | partially_supported | unsupported | conflicting
  -> final grouped report
```

This keeps deep research broad without presenting every discovered claim as equally reliable.

### 3. Change normalization output from a single verification list to an inventory

Current normalize output centers on:

```json
{
  "claimsForVerification": []
}
```

Proposed shape:

```json
{
  "claimInventory": {
    "verificationCandidates": [],
    "unverifiedClaims": [],
    "duplicates": [],
    "outOfScopeClaims": [],
    "lowValueClaims": []
  },
  "coverageGaps": [],
  "normalizationNotes": "..."
}
```

`verificationCandidates` is the only bucket sent to the verify stage. Other buckets are preserved so the workflow remains deep and auditable.

Each normalized claim should have a stable ID. Each `verificationCandidates` item should include:

```json
{
  "id": "claim-004",
  "claim": "...",
  "sourceUrls": ["..."],
  "sourceQuality": "high|medium|low|unknown",
  "reasonToVerify": "...",
  "scopeItems": ["LLM-as-judge reliability"],
  "verificationNeed": "core|useful|optional"
}
```

Bucket transition rules:

- `verificationCandidates`: valid, source-backed, central claims selected for verification within the depth budget.
- `unverifiedClaims`: valid research details worth preserving but not verified because they exceeded budget, were lower priority, or did not require rigorous verification for the report's main findings.
- `duplicates`: claims merged into another normalized claim ID.
- `outOfScopeClaims`: claims outside the extracted research scope.
- `lowValueClaims`: vague, generic, or weakly sourced claims not useful enough to carry forward.

Avoid over-relying on generic `high-risk` / `high-impact` language. If used, it should be grounded in research accuracy, not parent decision-making.

### 4. Verification should gate evidence strength, not just annotate

Verification statuses remain:

```text
verified | partially_supported | unsupported | conflicting
```

But final reporting should treat them differently:

- `verified` -> eligible for `mainFindings`
- `partially_supported` -> `caveatedFindings`
- `conflicting` -> `contestedFindings`
- `unsupported` -> `unsupportedClaims`
- not verified -> `unverifiedClaims`

Each synthesized finding must reference supporting claim IDs from the evidence packet. This keeps the final report concise while allowing the parent session to inspect the underlying evidence.

This avoids calling weak or uncertain claims verified while preserving them for inspection.

### 5. Final report should be a research report, not a decision brief

The final output should remain research-oriented.

Proposed shape:

```json
{
  "finalReport": {
    "summary": "...",
    "coverageSummary": {
      "depth": "standard",
      "researchQuestions": 7,
      "rawClaimsApprox": 88,
      "verificationCandidates": 48,
      "verified": 0,
      "partiallySupported": 0,
      "unsupported": 0,
      "conflicting": 0,
      "unverified": 0,
      "coverageGaps": 0
    },
    "mainFindings": [
      {
        "finding": "...",
        "supportingClaims": ["claim-004", "claim-012"],
        "confidence": "high"
      }
    ],
    "caveatedFindings": [],
    "contestedFindings": [],
    "unsupportedClaims": [],
    "unverifiedClaims": [],
    "researchScopeCoverage": [],
    "remainingGaps": []
  },
  "evidencePacket": {
    "verifiedClaims": [],
    "partiallySupportedClaims": [],
    "conflictingClaims": [],
    "unsupportedClaims": [],
    "unverifiedClaims": []
  }
}
```

The final report may summarize and group. The evidence packet may contain fuller details, but should avoid making the parent session believe unsupported or unverified claims are main findings.

## Depth mode implications

Current depth policy:

- questions:
  - quick target 3 / cap 6
  - standard target 6 / cap 12
  - max target 12 / cap 24
- normalized verification claims:
  - quick target 8 / cap 16
  - standard target 24 / cap 48
  - max target 48 / cap 96

Proposed initial approach:

- Keep existing question and verification-candidate caps for now.
- Add a soft per-question raw-claim target, not a hard deletion rule. For example: quick target 5 raw claims/question, standard target 8, max target 12.
- If a research subagent finds more useful claims than the target, it should prioritize the strongest claims in `claims` and summarize the rest as `additionalUnverifiedLeads` rather than silently discard them.
- Preserve claims that are not verified as `unverifiedClaims` rather than discarding them silently.
- Use lifecycle buckets and reporting counts to learn whether caps are harming quality before reducing them.

Reason: prematurely limiting raw claims may undermine the "deep" part of deep research. A soft target plus explicit unverified leads controls verbosity while preserving breadth.

## Open questions for reviewers

1. Is flat-array `covers` enough, or do we need richer scope metadata later?
2. Is separating `researchScope` extraction from question planning enough to avoid self-justifying coverage boilerplate?
3. Is preserving unverified claims valuable, or will it overload the final artifact?
4. Should `verificationCandidates` caps remain unchanged initially, or should standard/max be reduced immediately?
5. Are `mainFindings`, `caveatedFindings`, `contestedFindings`, `unsupportedClaims`, and `unverifiedClaims` the right buckets?
6. Does `finalReport + evidencePacket` keep the parent session informed without turning the workflow into a decision-maker?
7. What is the smallest change that improves accuracy without compromising depth?

## Success criteria

A successful revision should make it easier to inspect:

- what was covered,
- what was missed,
- how many claims were discovered,
- how many were verified,
- which claims are safe to treat as findings,
- which claims require caveats or further research.

It should not reduce `deep-research` to a shallow summary or a parent-decision workflow.
