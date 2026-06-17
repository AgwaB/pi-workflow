# Bug Forge

Local, private-by-default benchmark construction area for pi-workflow A/B eval seeded-review tasks.

## Purpose

Create discriminating code-review tasks from realistic invariant violations rather than random broken code.

A task is a local PR-like fixture:

```text
tasks/<neutral-task-id>/
├── task.json                # maintainer metadata; only `candidateVisible` fields are candidate-safe
├── author-notes.md          # private maintainer notes; never copied to candidate workspace
├── gold-key.draft.json      # private oracle draft; not candidate-visible
├── reference-fix.patch      # private oracle/reference; not candidate-visible, once authored
├── fixture.diff             # candidate-visible proposed patch, once authored
└── repro.sh                 # maintainer-only deterministic check, once authored
```

## Core invariants

1. Candidate sees only a sanitized repo snapshot plus the proposed diff.
2. Candidate must not see gold keys, scoring, A/B arm labels, prior reports, notes, run directories, or git history.
3. Bug presence is hidden. A task may contain no material issue.
4. Gold keys are authored/reviewed with multi-provider LLM assistance, then locked as artifacts before scoring.
5. Primary score is objective gold-key matching, not LLM judge preference.
6. LLM judge is secondary/audit only.

## Pilot plan

Current task set contains the original 15-task pilot plus a 12-task local blind holdout:

- `review-case-a1` — easy location/dataflow regression calibration only.
- `review-case-b2` — saturated runtime task propagation draft; needs subtler replacement.
- `review-case-c3` — locked no-issue / adversarial overclaim control.
- `review-case-d4` — fallback location parser precision discriminator candidate.
- `review-case-e5` — report runtime-task propagation draft; saturated for direct arms.
- `review-case-f6` — subtler E5 replacement: reduce-stage runtime task prompt injection.
- `review-case-g7` — provider thinking-level null-map semantics.
- `review-case-h8` — artifact graph catalog schema compatibility.
- `review-case-i9` — foreach JSONPath schema/runtime contract.
- `review-case-j10` — Scrapling read-only tool classification.
- `review-case-k11` — workflow output outside-text protocol validation.
- `review-case-l12` — sourceProjection bypass in Source Context.
- `review-case-m13` — foreach maxItems inclusive boundary.
- `review-case-n14` — partial sourcePolicy inversion.
- `review-case-o15` — blocked workflow status priority.
- `review-case-p16`..`review-case-aa27` — local blind holdout covering runtime default precedence, prompt injection opt-in, partial failure semantics, required read validation, workflow registry robustness, path containment, and two no-issue controls.

The second-wave tasks are draft until calibration and provider review decide which ones remain non-saturated and objective enough to lock. The P16-AA27 holdout is locally locked for backtesting only; do not tune workflow behavior on its results until failures are recorded and provider review promotes the tasks.

## Scripts

```bash
# Validate JSON, fixture apply checks, and scorer self-tests
node .pi/eval/bug-forge/scripts/validate.mjs

# Materialize a sanitized candidate workspace for one task
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-a1

# Score a candidate output against a private gold key
node .pi/eval/bug-forge/scripts/score-output.mjs \
  --gold .pi/eval/bug-forge/tasks/review-case-a1/gold-key.draft.json \
  --output /path/to/candidate-output.md
```

Workflow calibration arms generate a run-local workflow spec variant under
`<run>/workflow-variants/` with `defaults.model` and `defaults.thinking` pinned
to the calibrator arguments. This prevents ambient Pi defaults from silently
changing the model used by workflow subagents.

## Status

Pilot fixture diffs, gold drafts/reference fixes, validation/repro scripts, local validation scripts, provider review artifacts, and calibration runs exist. D4 has a behavioral repro that demonstrates the seeded localization loss and verifies the reference fix.

Latest completed calibration: `.pi/eval/bug-forge/runs/calibration-gen2-20260615T161626Z/analysis.md`.

Latest second-wave calibration:

- Direct F6-O15: `.pi/eval/bug-forge/runs/calibration-wave2-direct-20260615T172215Z/analysis.md`
- Workflow subset J10/M13: `.pi/eval/bug-forge/runs/calibration-wave2-workflow-20260615T175939Z/analysis.md`

Current result: C3 and D4 are locked usable tasks. D4 is a provider-reviewed precision/over-splitting discriminator. J10 and M13 are revised draft candidates after provider review: J10 is a hard-miss candidate; M13 is a self-check/output-format and workflow precision candidate. Most other second-wave tasks saturated in direct calibration and should be demoted or rewritten before primary use.
