# pi-subagent-flow Recovery Report

## Current status

The directory `/Users/toby/pi/pi-subagent-flow` has been restored, but it is **not fully recovered**.

Confirmed:

- `package.json` exists and identifies the package as `pi-workflow@0.1.0`.
- Many source/docs/eval files are present.
- The latest deep-research improvement planning document exists:
  - `docs/deep-research-improvement-plan-20260607.md`
- Deferred workflow candidates have been moved back out of the current bundle into:
  - `internal/plans/deferred-workflows/`
- Current bundled workflow directory now contains only:
  - `workflows/deep-research.json`
  - `workflows/deep-review.json`
  - `workflows/README.md`

Not recovered / still broken:

- `.git/` is missing. This directory is not a git repository.
- `docs/deep-research-run-trace-20260607.md` is missing.
- Original raw trace inputs are missing:
  - `.pi/workflows/workflow_mq3d1nkq_ac6b53/...`
  - `.pi/eval/ab-execution/runs/run-20260607T120050Z/...`
- `npm run typecheck` currently fails because the restored tree is a mixed partial state.
- Active source/docs still contain old `recipe`/legacy terminology; the full terminology cleanup is not restored.

## Safety backup

Before AI-assisted recovery changes, this backup was created:

- `/Users/toby/pi/pi-subagent-flow-current-before-ai-recovery-20260608T021204.tar.gz`

Additional restore tarballs already present before this recovery pass:

- `/Users/toby/pi/pi-subagent-flow-recovered-20260608T020525-prevalidate.tar.gz`
- `/Users/toby/pi/pi-subagent-flow-recovered-20260608T020833-from-session-logs.tar.gz`

## Recovery actions performed

1. Inventoried current restored tree and tarball contents.
2. Scanned Pi and Claude session logs for recoverable `write`/`edit`/tool outputs.
3. Extracted session tool-call metadata under:
   - `.recovery/session-scan/`
   - `.recovery/tool-calls/`
   - `.recovery/full-write-files/`
4. Restored high-confidence missing file:
   - `src/workflow-specs.ts` from `.recovery/full-write-files/src/workflow-specs.ts`
5. Re-applied confirmed bundle narrowing:
   - moved `best-of-n-fix.json`, `decision-debate.json`, `implement.json`, `migration.json`, `revise-loop.json` from `workflows/` to `internal/plans/deferred-workflows/`.
6. Recovered supporting evidence from session logs:
   - `.recovery/deep-research-run-trace-generation-command.sh`
   - `.recovery/kimi-deep-research-trace-review.md`

## Why full automatic replay was not applied

Session logs contain thousands of historical `write`/`edit` tool calls. A dry-run of replaying the latest workflow-spec/terminology edits found most patch-style edits do not match the restored partial tree. Applying them blindly would risk corrupting the repository further.

Dry-run result for post-2026-06-07T07:22 tool-call replay:

- records considered: 86
- writes: 9
- edits: 77
- edits that matched current tree: 4
- edits that failed to match: 73

Reason: the restored tree is not the exact pre-edit baseline those patches were generated against.

## Validation performed

Command:

```bash
npm run typecheck
```

Result: failed.

Representative errors:

- missing/new type exports such as `WorkflowValidationError`, `WorkflowTaskRunRecord`, `WorktreeSnapshotRecord`
- mismatches between older `Flow*` APIs and newer `Workflow*` files
- missing/partial newer files such as `src/workflow-specs.ts` dependencies

## Important recovered evidence

- The planning doc is recovered:
  - `docs/deep-research-improvement-plan-20260607.md`
- The trace generation command is recovered, but cannot be rerun until raw workflow/eval artifacts are restored:
  - `.recovery/deep-research-run-trace-generation-command.sh`
- Kimi's trace critique was recovered from session output:
  - `.recovery/kimi-deep-research-trace-review.md`

## Recommended next steps

1. Restore `.git/` or reclone the original repository from remote.
2. Treat the current directory as a salvage tree, not a trusted working tree.
3. Use `.recovery/full-write-files/` and `.recovery/tool-calls/` as evidence for manual patch reconstruction.
4. Re-apply latest known product decisions onto a clean git checkout:
   - public term is `workflow`, not `recipe`
   - remove legacy recipe aliases/paths
   - current bundled workflows are only `deep-research` and `deep-review`
   - deferred workflows live under `internal/plans/deferred-workflows/`
   - A/B eval metadata includes `evaluationHypothesis`
5. Rebuild missing `docs/deep-research-run-trace-20260607.md` only if the raw workflow/eval artifacts can be restored; otherwise mark it unrecoverable rather than fabricating raw JSON.
6. After clean checkout reconstruction, run:
   - `npm run typecheck`
   - `npm test`
   - `PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --dry-run`
   - `PI_WORKFLOW_ROLE=disabled node .pi/eval/ab-execution/run.mjs --self-test`
