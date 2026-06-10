# Deep Research Dynamic Roadmap

Date: 2026-06-09

## Why

The Sonnet comparison in `docs/deep-research-ab-sonnet.md` showed that Claude Code's dynamic workflow did not win because it used more agents alone. It won an important factual detail because the generated workflow made the topic-specific extraction schema explicit: search/fetch were keyed to prompt-caching dimensions such as TTL, pricing, breakpoints, and prefix requirements.

`deep-research` should keep its audit trail and verifier/final separation, but become more topic-adaptive so critical facts are planned, extracted, verified, and handed off to the parent session instead of disappearing into generic claims or gaps.

## Implementation Slices

### DR-001 Plan schema upgrade
Status: implemented.

Plan now produces:
- `taskType`
- `researchAxes`
- `factSlots`
- `sourcePolicy`
- `verificationPriorities`
- `expectedFinalShape`
- `planRisks`
- `researchQuestions[].coversFactSlots`

### DR-002 Slot-keyed research extraction
Status: implemented.

Research workers now return `extractedFacts[]` keyed to planned fact slots, preserving exact values, entities, source URLs, source quality, quotes, and confidence.

### DR-003 Normalize slot coverage
Status: implemented.

Normalize now returns `factSlotCoverage[]` and prioritizes verification candidates that fill required, numeric, pricing, TTL, limit, version, date, policy, or vendor/entity-specific slots.

### DR-004 Numeric/vendor-sensitive verification
Status: implemented.

Verifier prompts now require exact value/unit/vendor/model/date checks for numeric and policy claims, preserving `factSlotIds` and using corrections/counterclaims for overgeneralized claims.

### DR-005 Parent-facing final handoff
Status: implemented.

Final output now requires:
- `finalReport.researchMetadata`
- `finalReport.factSlotCoverage`
- `finalReport.unverifiedButRelevant`
- `finalReport.parentDecisionNotes`

The final stage should preserve ambiguity for the parent session instead of deleting partial, conflicting, unsupported, or unverified-but-relevant material.

## Validation

Deterministic validation should include:

```bash
node -e "JSON.parse(require('fs').readFileSync('workflows/deep-research.json','utf8')); JSON.parse(require('fs').readFileSync('workflows/templates/deep-research.json','utf8')); console.log('json ok')"
npm test
npm run typecheck
git diff --check
```

Model validation should use a quick comparison task and check that:
- plan creates meaningful `factSlots`
- research returns slot-keyed `extractedFacts`
- normalize returns `factSlotCoverage`
- final includes `researchMetadata`, `factSlotCoverage`, `unverifiedButRelevant`, and `parentDecisionNotes`

A later Sonnet prompt-caching rerun should verify whether OpenAI cached-input pricing remains separated from Claude cache-read pricing.
