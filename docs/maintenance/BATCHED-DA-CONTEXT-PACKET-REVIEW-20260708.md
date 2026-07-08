<!-- markdownlint-disable MD013 -->

# Batched devil-advocate context packet follow-up review

Date: 2026-07-08

Tracked copy: `docs/maintenance/BATCHED-DA-CONTEXT-PACKET-REVIEW-20260708.md`

Reviewer response source: `.tmp/batched-da-context-packet-review-response-20260708.md`

## Status

Implemented but **not committed**.

Changed files:

- `workflows/deep-review/helpers/finding-pipeline.mjs`
- `workflows/deep-review/batched-devil-advocate.spec.json`
- `test/unit/unit.test.mjs`
- `docs/maintenance/BATCHED-DA-CONTEXT-PACKET-REVIEW-20260708.md`

This remains opt-in-only. The default `workflows/deep-review/spec.json` was not changed.

## What was done

- Added row-local `contextPacket` generation for opt-in batched deep-review devil-advocate batches.
- Added bounded repository snippets / quote matches with stable refs such as `CTX-finding-001-1`.
- Updated the batched DA prompt to require row-local contextPacket citations in `evidence` and mirrored pointers in `<refs>`.
- Strengthened reducer fail-closed behavior for batched `repository_context` `KEEP` rows that do not cite row-local context or a concrete repository pointer.
- Fixed the repo-root blocker by threading workflow helper `context.cwd` into context packet file reads instead of relying on `process.cwd()`.
- Added tests for:
  - prompt contract mentions row-local context and refs,
  - context packet creation using `context.cwd` even when the embedding process has a different cwd,
  - unsafe path containment,
  - quote-match fallback when line numbers are absent,
  - existing packet cloning,
  - accepted grounded `KEEP`,
  - demoted ungrounded `KEEP`.
- Moved the decision record to a tracked docs path instead of unignoring `internal/maintenance/`.

## Validation evidence

- Focused batched deep-review tests: passed.
- `npm run validate`: passed.
- Local context packet summary on the 25-finding fixture: 22/25 concrete packets, 86 concrete evidence refs.
- User-approved post-fix replay completed.

Post-fix replay:

| Metric | Default | Batched | Delta / note |
| --- | ---: | ---: | --- |
| Run | `workflow_mrbzwo5k_105531` | `workflow_mrc01hkn_0b1ed7` | — |
| Wall time | 224.738s | 79.691s | -145.047s |
| DA tasks | 25 | 7 | -18 |
| Tokens | 2,073,646 | 861,362 | -1,212,284 |
| Cost | $4.430125 | $1.628396 | -$2.801729 |
| Exact / merge-aware matches | — | 12/25 | prior N=1 replay was 15/25; this supports “no demonstrated improvement,” not “worse” |
| Potential over-dismiss | — | 3 | needs manual adjudication; default is not ground truth for stale fixture rows |
| Potential over-accept | — | 2 | needs manual adjudication; default is not ground truth for stale fixture rows |

## Conclusion

The implementation improves the **input contract** and row-local evidence availability, but the single live replay did **not** demonstrate quality parity or improvement. A 12/25 vs prior 15/25 match result at N=1 vs N=1 is underpowered; call it “did not improve,” not “worse.”

The risky drift rows also need manual adjudication against today’s repository before counting them as quality loss, because default DA is not ground truth and some fixture findings may be stale.

Do **not** claim “quality maintained while faster.” Do **not** default-flip.

## Review decision

Owner/reviewer P0 decision: **keep the change as grounding infrastructure**, not as a quality fix.

Preconditions before commit:

1. Repo-root blocker must be fixed: use workflow helper `context.cwd` for context packet file reads, not `process.cwd()`.
2. Commit message must frame the change as infrastructure, e.g. `feat: add row-local context packets for batched review evidence`.
3. No commit message, docs, release notes, or public claim may imply quality parity/improvement.

## Review needed before wider adoption

### P0 — Verdict calibration / semantic policy

The next likely root cause is not context availability alone but verdict semantics/calibration under batching. The useful question is not “does batched match default?”; it is “on rows where the correct verdict is knowable, is batched right?”

Reviewer guidance:

- Stale/already-fixed findings: consistently `DROP` with a `stale_fixed` note.
- Optimization-only findings: `WEAKEN` by default is acceptable until adjudication shows otherwise.
- Do not add a per-row “what would make this match default?” counterfactual yet; it anchors batched output on default verdicts and increases cost.

### P1 — Context packet implementation details

Current / decided:

- `context.cwd` should be the repo root for packet reads. `process.cwd()` is the embedding process cwd and was a blocker.
- Packet size defaults remain reasonable pending real token-budget data: 4 locations, 10 quotes, 4 snippets, 2k chars/snippet.

Remaining review questions:

- `path.resolve` containment does not dereference symlinks. Should we add `fs.realpathSync` containment for prompt-read hardening?
- Quote matching currently searches bounded location files. Should it also search the primary `finding.file` when locations are absent/incomplete?
- Confirm line-based snippets and line drift behavior are acceptable.

### P1 — Reducer guardrail strictness

Current behavior:

- `repository_context KEEP` must cite a contextPacket ref or concrete repo pointer.
- `concrete_artifact KEEP` can bypass contextPacket refs.

Reviewer guidance:

- Verify cited file paths exist instead of trusting any `file:line`-like text.
- Do **not** require `CTX-*` when the agent performed an independent read; verified repo pointer or CTX ref should be acceptable.
- Extend missing-context demotion to `DROP` rows because over-dismiss is the top observed risk.
- Leave `WEAKEN` free for now.

### P1 — Prompt / refs behavior

Post-fix replay had 0 structured `refs` emitted by batched tasks, although 12/25 rows cited `CTX-*` in evidence. The prompt now asks to mirror pointers in `<refs>`, but this has not been replayed again after that small follow-up.

Reviewer guidance:

- Do not enforce `<refs>` in the reducer until a replay shows models actually emit them.
- Evidence-text CTX citations are a sufficient interim contract.

### P1 — Fallback routing

Reviewer guidance:

- Route `missing_context` rows straight to `NEEDS_HUMAN` with no model call; do not send them to single-finding DA, because single DA has no equivalent fail-closed gate.
- Routing high-severity/API-compat findings to single DA even with context is reasonable, but should be a separate policy change.

### P2 — Evaluation matrix

Needed before adoption/default claims:

1. First run the same config replay 3× to measure baseline variance. Without this, future 2–3-row deltas are uninterpretable.
2. Manually adjudicate the 5 risky rows, especially over-dismiss and over-accept, against today’s repo.
3. Batch size sweep: 1 vs 2 vs 4.
4. Same-packet single-vs-batch comparison to isolate multi-finding attention effects.
5. Replay with row-local refs prompt after the latest prompt follow-up.
6. Higher-N repeated repo-grounded replay after variance baseline is known.

## Follow-up implementation status

Completed in the follow-up hardening pass:

1. **Reducer path verification:** cited file-line pointers must resolve inside the repo before they count as grounding.
2. **Missing-context DROP demotion:** non-`concrete_artifact` `DROP` rows without concrete packet evidence or verified independent file-line evidence route to `NEEDS_HUMAN`.
3. **Symlink realpath containment:** context-packet file reads reject repo symlinks that resolve outside the repository.

Still open:

1. **Conservative fallback policy:** route missing-context rows to `NEEDS_HUMAN` earlier, before model calls; optionally route high-severity/API rows to single DA in a separate policy change.
2. **Batch size / policy tuning:** use eval results before changing max batch size or verdict rubrics.
3. **Policy rubric:** add explicit verdict calibration rules for stale fixes, optimization-only findings, missing historical artifacts, and support-only issues.

## Do not do yet

- Do not commit as “quality improvement.”
- Do not default-flip batched DA.
- Do not publish speed+quality claims.
- Do not remove fail-closed reducer strictness.
