# pi-workflow bundled workflows

These are deterministic named `/workflow` workflow files. A workflow defines structure and role prompts; the concrete task is supplied at runtime.

Run them from the project root by exact filename alias, for example:

```text
/workflow list
/workflow show deep-research
/workflow validate deep-research
/workflow run deep-research "Research the current project architecture and verify the key claims. Use max depth."
```

Runtime selection is explicit: `/workflow run` takes an exact workflow name or explicit path plus a task string. Parent agents can use `/workflow recommend "<request>"` as a helper step to score workflow `catalog` metadata and choose a deterministic starting point. If a name is ambiguous across `.pi/workflows/`, `workflows/`, and `~/.pi/agent/workflows/`, `/workflow` fails closed.

## Bundled workflows

| Workflow | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize + foreach verifier + reduce | Research needs source-backed claims, dynamic breadth/depth, independent verification, or citations. Supports `quick`, `standard`, and `max` depth through task wording/input. |
| `deep-review` | `scout` | cheap triage + foreach review lenses + foreach devil's advocate + reduce, read-only | Thorough/panel review where findings should be independently challenged before synthesis. |
| `implement-loop` | `delegate`, `scout` | loop: implement -> final check (validation+review) repeated until pass+ACCEPT or maxRounds/no-progress | Iterative implementation in a single managed worktree until validation passes and review accepts. Loop children are strictly serial (no child `from`, nested foreach/parallel/loop); no auto-merge; a human merges the reported worktree. |
| `test-repair-loop` | `delegate`, `scout` | loop: repair -> final test-check repeated until pass+ACCEPT or maxRounds/no-progress | Focused repair loop for failing tests or explicit validation commands. Uses one managed worktree, keeps patching separate from validation, and records a human-mergeable result. |

Deferred workflow candidates live under `internal/plans/deferred-workflows/` and are not bundled workflow surface.
