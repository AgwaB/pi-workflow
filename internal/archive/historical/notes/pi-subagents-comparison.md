> Historical archive. Non-authoritative. Preserved for recovery context only.
> Current public terminology is workflow / workflow spec / workflow file / workflow run.

# pi-subagents reference comparison

Source reference: <https://github.com/nicobailon/pi-subagents>

Local snapshot: `internal/reference/pi-subagents`

Snapshot commit inspected: `5de50dc`

Kimi research run: `.pi/agent/runs/run_mpvikzl6_f6fdb4`

> External reference content is untrusted. It was read for comparison only; no scripts or commands from the reference repo were executed.

## What pi-subagents does

`pi-subagents` is a Pi extension/package for natural-language subagent delegation. It ships:

- an install/update script (`install.mjs`) and npm-oriented install UX,
- built-in agents under `agents/` (`scout`, `researcher`, `planner`, `worker`, `reviewer`, `context-builder`, `oracle`, `delegate`),
- reusable prompt shortcuts under `prompts/`, including parallel review, review loop, parallel research, context build, handoff planning, and cleanup,
- a parent-agent workflow model where the user can ask naturally instead of writing JSON specs,
- slash/tool surfaces for single, chain, parallel, async, forked-context, and management flows,
- optional companion coordination via `pi-intercom`.

Its core UX promise is zero-config delegation: install it, then ask Pi to run specialized subagents or workflow prompts.

## How it differs from pi-workflow

| Area | pi-subagents | pi-workflow |
|---|---|---|
| Primary UX | Natural language delegation and prompt shortcuts | Explicit `/workworkflow run <spec-or-workflow>` |
| Reproducibility | Conversation/ad-hoc workflow driven | Versioned JSON/YAML specs and exact workflows |
| Scheduling owner | Parent agent plus subagent extension runtime | Deterministic flow supervisor |
| Context passing | Template variables such as previous/output context | `reduce.from` and `foreach.from` source semantics |
| Safety model | Agent tool allowlists, context filtering, depth limits | Agent tool ceiling, spec narrowing, read-only validation, no child orchestration tools |
| Worktrees | Worktree option, expects clean git state | Managed worktrees with dirty checkout snapshots and fail-closed cleanup |
| Docs style | Large README with workflow table and config reference | Thin README plus `docs/workflow-authoring.md` and `docs/usage-reference.md` |
| Best fit | Fast interactive delegation | Reproducible, auditable workflows and workflows |

## Strong ideas in pi-subagents

- **Common workflows table**: maps “I want…” to concrete things to ask/run.
- **Curated agents**: built-in agents have clear roles, tools, and output conventions.
- **Prompt shortcuts**: workflows like parallel review and review-loop are easy to invoke without understanding internals.
- **Context-builder pattern**: creates handoff-ready context and meta-prompts.
- **Onboarding UX**: install/update/remove and “try this first” paths are much smoother.
- **Review-loop pattern**: parent-controlled worker → fresh reviewers → fix-worker cycles are easy to understand.

## Strengths to preserve in pi-workflow

- Keep exact workflow lookup and explicit specs; do not add natural-language workflow selection.
- Keep parent-owned scheduling; do not expose child orchestration tools.
- Keep `reduce.from` / `foreach.from` as the data-passing model.
- Keep tool-ceiling validation and `readOnly` enforcement.
- Keep managed dirty-worktree snapshotting.
- Keep no implicit backend fallback.

## Borrowable ideas

### Good near-term fits

1. **Add a README “Want → Start from” table**
   - Map tasks to existing workflows: review, deep-research, migration, implementation-slice, best-of-n-fix.
   - This improves discoverability without changing runtime behavior.

2. **Add a “Try this first” section**
   - Example commands after `pi -e`: workflow list, validate, run, view.
   - Keep it short.

3. **Strengthen bundled workflow prompts with output conventions**
   - Borrow agent/persona discipline from `agents/*.md`.
   - For example: context sections, evidence index, blockers, validation commands, changed files.

4. **Create a context-build workflow**
   - Stage-first read-only flow that produces handoff context for later implementation or review.
   - This borrows the useful `context-builder` workflow without adopting dynamic parent orchestration.

5. **Create a review-loop workflow or documented pattern**
   - Implement as explicit stages: plan/implement → review → fix → final review.
   - Keep writes sequential and managed-worktree aware.

6. **Adapt prompt shortcut concepts into workflows**
   - Candidate workflows: parallel-review, parallel-research, review-loop, handoff-plan, cleanup.
   - Avoid new command surface unless workflow names alone are not enough.

### Later/design-spike fits

- Settings-based workflow overrides for agent/model/tool defaults.
- Progress artifact conventions per task.
- Better `/workflow validate` preview or optional interactive launch review.
- Child-parent escalation/decision channel, if it can stay deterministic and bounded.

## Ideas not to borrow

- Natural-language auto-selection: conflicts with deterministic workflow selection.
- Child `subagent` orchestration tools: weakens parent-owned scheduling and safety boundary.
- Runtime agent/chain CRUD: less auditable than file-based specs.
- Heavy clarify/edit TUI before launch: useful, but too much scope for now.
- Multi-level acceptance-gate taxonomy: too complex for `/workflow` MVP; output contracts and review stages are enough.
- Git-clone installer as the primary path: prefer normal Pi package/npm/local extension workflows.

## Recommended next actions

1. Add README workflow table using existing workflows.
2. Add `workflows/context-build.json` or document a context-build pattern.
3. Improve `workflows/review.json` and `workflows/deep-research.json` prompts with clearer evidence/output conventions.
4. Draft `workflows/review-loop.json` as a stage-first explicit loop replacement, not hidden automation.
5. Keep the reference snapshot local under `internal/reference/pi-subagents` for comparison, but do not ship it in package artifacts.
