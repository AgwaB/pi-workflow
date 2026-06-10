# pi-workflow Remaining Work Handoff — 2026-06-10

## Context

This repository is `pi-workflow`, a Pi extension/package for workflow-defined orchestration of Pi subagents.

Recent completed work:
- Workflow bundle support: `workflows/<name>/spec.json`.
- `type: "transform"` stages.
- Directory-local `.mjs` helper loading with containment.
- Transform runtime execution.
- Bundle artifact preservation.
- `deep-research` migration to bundle layout with `audit-claims` helper.
- Documentation cleanup for current bundled workflows.
- Minimal A/B eval hardening with `answerKeyRef` and private answer-key storage.

Recent validation passed:

```bash
node --check .pi/eval/ab-execution/run.mjs
node .pi/eval/ab-execution/run.mjs --self-test
node .pi/eval/ab-execution/run.mjs --dry-run --task review-seeded-safety-diff
npm test
npm run typecheck
git diff --check
npm run e2e
```

Latest E2E report:

```text
e2e-test/results/run-20260610T121235Z/report.md
```

Harness status from prior run:
- Delivery signed as `ready-with-notes`.
- No deploy, publish, push, upload, or external mutation occurred.

## Current Important Files

Core implementation:
- `src/workflow-specs.ts`
- `src/schema.ts`
- `src/types.ts`
- `src/compiler.ts`
- `src/workflow-helpers.ts`
- `src/engine.ts`
- `src/store.ts`
- `test/unit.test.mjs`

Workflow bundle:
- `workflows/deep-research/spec.json`
- `workflows/deep-research/templates.json`
- `workflows/deep-research/helpers/claim-evidence-gate.mjs`
- `workflows/README.md`
- `README.md`

Eval runner:
- `.pi/eval/ab-execution/run.mjs`
- `.pi/eval/ab-execution/tasks.json`
- `docs/general-ab-eval-design.md`

Private eval answer key now lives outside repo:

```text
~/.pi/agent/eval-private/pi-workflow/answer-keys/review-seeded-safety-diff.json
```

`tasks.json` now references it via:

```json
"answerKeyRef": "private://review-seeded-safety-diff.json"
```

## Remaining Work

### 1. Dependency Strategy — Release Blocker

Current `package.json` dependency still intentionally points to a local file dependency:

```text
@agwab/pi-subagent: file:../pi-subagent-engine
```

Before publishing/release, decide one of:

1. Publish/version `@agwab/pi-subagent` with required upstream changes.
2. Vendor or bundle the needed engine changes.
3. Keep as local-only prerelease and document that release is blocked.

Required upstream/local engine capabilities include:
- streaming stdout parser/filter
- `captureToolCalls`
- tool availability/fail-fast support
- any provider registration behavior relied on by workflow web tools

Do not claim npm-release readiness until this is resolved.

### 2. Strong Eval Isolation — Next Major Work

Minimal A/B hardening is done. Strong isolation remains.

Goal:
- Candidate arms must not see answer keys, judge prompts, rubrics, prior eval artifacts, or hidden fixtures.

Recommended sequence:

1. Sanitized worktree per arm.
2. Strict eval-artifact deny/audit mode.
3. Mount/visibility split:
   - arm-visible: task prompt, allowed fixture, sanitized repo snapshot
   - judge-only: rubric, judge prompt, answer key
   - internal-only: raw stdout/stderr, mappings, audits, provider failures
4. Gondolin sandbox spike.

Relevant doc:

```text
docs/general-ab-eval-design.md
```

Important: general eval harness expansion is deferred. Keep current runner diagnostic-only until isolation is stronger.

### 3. Review Unexpected Existing Modified File

`git status` showed this file modified:

```text
.pi/eval/review-ab/run.mjs
```

This was not part of the main workflow-local-helper implementation. Before commit/release:
- inspect its diff;
- decide whether it belongs in the same change;
- otherwise split/revert/stash separately.

Do not silently include unrelated changes.

### 4. README / Diagram Asset Refresh

`README.md` text now includes `audit-claims`, but image assets may still show the old flow.

Check/update:

```text
docs/assets/readme-deep-research.png
docs/assets/readme-stage-types.png
```

If stale, regenerate or update diagrams so the README does not contradict actual workflow stages.

### 5. `deep-research-sonnet-low` Strategy

This file remains flat and still references the old shared template path:

```text
workflows/deep-research-sonnet-low.json
workflows/templates/deep-research.json
```

Decide whether to:
1. keep it as a legacy/variant workflow;
2. migrate it to bundle layout;
3. archive/remove it from bundled surface.

If keeping it, ensure docs clearly explain whether it is supported or experimental.

### 6. Legacy Docs Cleanup

Some historical docs still mention old terminology/paths, for example:

```text
docs/deep-research-ab-sonnet.md
```

The E2E legacy-term grep currently excludes this file. If docs are public-facing, clean it up instead of relying on the exception.

Focus terms/paths:
- `recipe`
- old flat `workflows/deep-research.json`
- old template path examples if presented as current usage

Historical/archive references can remain if explicitly labeled as historical.

### 7. Eval Private Key UX

`answerKeyRef: private://...` depends on a local private key file.

Potential issue:
- On another machine, dry-run/eval will fail unless the private key file exists.

Add one of:
1. setup/bootstrap instructions;
2. a script to install private keys locally from a secure source;
3. clearer error text/documentation that seeded answer-key tasks require private local keys.

Do not move raw answer keys back into repo-visible task specs.

### 8. Evaluation Claims Discipline

Continue treating A/B results as diagnostic only.

Do not make broad workflow-superiority claims until at least:
- strong isolation is implemented;
- answer keys are held out from arm-visible workspaces;
- held-out benchmark tasks exist;
- compute-matched baselines exist;
- judge variance is measured with pairwise/swapped or cross-provider judging.

### 9. General Eval Harness — Deferred Roadmap

Do not implement now unless explicitly asked.

Future direction:
- generic arm spec for agents/workflows/models/prompts;
- compute-matched baselines;
- pairwise swapped judging;
- token/cost accounting;
- semantic citation support auditing;
- held-out fact-verification benchmark set.

This is now captured as deferred roadmap in:

```text
docs/general-ab-eval-design.md
```

## Suggested Next Commands for New Model

Start by checking current working tree:

```bash
git status --short
git diff --stat
```

Then inspect unrelated/uncertain diffs:

```bash
git diff -- .pi/eval/review-ab/run.mjs
```

Run baseline validation before further changes:

```bash
npm test
npm run typecheck
git diff --check
npm run e2e
```

For eval runner checks:

```bash
node --check .pi/eval/ab-execution/run.mjs
node .pi/eval/ab-execution/run.mjs --self-test
node .pi/eval/ab-execution/run.mjs --dry-run --task review-seeded-safety-diff
```

## Guardrails

- Public terminology is `workflow`, not `recipe`.
- Do not add `/flow` shim.
- Do not store hidden answer keys in repo-visible task specs.
- Do not claim helper sandboxing; current helper policy is containment/reproducibility.
- Do not deploy/publish/push without explicit user instruction.
- Keep A/B claims diagnostic-only.
- Keep changes scoped; separate unrelated modified files before committing.
