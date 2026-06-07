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

Each planned research question should state what part of the runtime task it covers.

Proposed question shape:

```json
{
  "id": "llm-judge",
  "question": "How reliable is LLM-as-judge for code evaluation?",
  "covers": [
    {
      "scopeItem": "LLM-as-judge reliability",
      "source": "runtime task",
      "coverageRole": "primary"
    }
  ],
  "whyItMatters": "...",
  "searchQueries": ["..."],
  "expectedSourceTypes": ["academic papers", "benchmark docs"],
  "priority": "high"
}
```

`covers` is not meant to be a parent-decision mapping. It is a research-scope mapping: what part of the requested research scope this question is responsible for.

Also add plan-level `researchScopeCoverage`:

```json
{
  "scopeItem": "benchmark contamination",
  "coveredBy": ["contamination"],
  "status": "covered"
}
```

Allowed statuses:

```text
covered | partial | gap | out_of_scope
```

Prompt rule:

```text
If a researchScopeCoverage item is gap, either add a research question for it or explain why it is intentionally out_of_scope.
```

Purpose: this does not magically improve research, but it should expose missed scope items earlier and make omissions visible in the final report.

### 2. Preserve broad raw discovery, but make claim lifecycle explicit

Avoid treating all claims as equivalent. Instead, preserve broad discovery while separating claim states.

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

Each `verificationCandidates` item should include:

```json
{
  "claim": "...",
  "sourceUrls": ["..."],
  "sourceQuality": "high|medium|low|unknown",
  "reasonToVerify": "...",
  "scopeItems": ["LLM-as-judge reliability"],
  "verificationNeed": "core|useful|optional"
}
```

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
    "mainFindings": [],
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

- Keep existing numeric caps for now.
- Do not add a hard raw-claim cap yet.
- Preserve claims that are not verified as `unverifiedClaims` rather than discarding them silently.
- Use lifecycle buckets and reporting counts to learn whether caps are harming quality before reducing them.

Reason: prematurely limiting raw claims may undermine the "deep" part of deep research. The safer first step is evidence-state separation and visibility.

## Open questions for reviewers

1. Is `covers` as object-array research-scope mapping useful, or too much schema overhead?
2. Is plan-level `researchScopeCoverage` likely to reveal real omissions, or will it become LLM self-justification boilerplate?
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
