# Leakage and Isolation Protocol

## Goal

Candidate arms must review a local PR-like patch without access to oracle, scoring, A/B, prior run, or bug-forge planning material.

## Candidate-visible material

Allowed:
- Sanitized repository snapshot.
- Proposed fixture diff.
- Neutral candidate prompt.
- Standard local tooling required for review.

Forbidden:
- `.git/` and git history.
- `.pi/eval/` entirely, including notes, bug-forge, A/B execution assets, fixtures, runs, reports, and prior eval outputs.
- `gold-key*.json`, `reference-fix.patch`, scoring outputs, judge prompts, A/B mappings.
- Previous candidate outputs or reports.
- Task bucket, expected bug count, internal task title, source of the bug, or whether the patch is seeded/no-issue.

## Workspace materialization

Preferred flow:

```bash
# 1. Export source revision without git history.
git archive <source_revision> | tar -x -C <candidate_workspace>

# 2. Apply candidate-visible bad PR fixture.
cd <candidate_workspace>
git apply <fixture.diff>

# 3. Provide the prompt + diff + workspace path to the candidate.
```

If `git worktree` is used internally for convenience, copy or archive into a separate candidate workspace and remove `.git` before launching the candidate.

## Naming

Candidate-visible IDs must be neutral, e.g. `review-case-a1`, not `location-drop-v1`.

## Prompt constraints

The prompt must say:
- The patch may be correct or may contain issues.
- Report only grounded material issues.
- If no material issue exists, say so.

The prompt must not say:
- seeded bug
- answer key
- expected number of findings
- easy/medium/hard/adversarial/no-issue bucket
- workflow/plain/self-check arm labels

## Post-run audit

Audit two channels separately:

1. Actual access/tool logs:
   - Any read/list/search of forbidden paths invalidates the candidate output.
2. Candidate output text:
   - Mentions of forbidden paths are reviewed with context.
   - A benign denial such as "I did not inspect `.pi/eval/`" is not itself a leak.
   - A claim that uses oracle/gold/scoring/A-B content is a leak even without path text.

## Fail-closed rule

If candidate contamination cannot be ruled out, mark the run invalid and rerun in a fresh sanitized workspace. Do not silently include contaminated outputs in aggregate scores.
