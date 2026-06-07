# pi-workflow recipe library

These recipes are deterministic named `/workflow` templates. A recipe defines structure and role prompts; the concrete task is supplied at runtime.

Run them from the project root by exact filename alias, for example:

```text
/workflow recipe list
/workflow recipe show deep-research
/workflow validate deep-research
/workflow run deep-research "Research the current project architecture and verify the key claims. Use max depth."
```

Runtime selection is explicit: `/workflow run` takes an exact recipe name or explicit path plus a task string. Parent agents can use `/workflow recommend "<request>"` as a hidden/helper step to score recipe `catalog` metadata and choose a deterministic starting point. If a name is ambiguous across `.pi/workflow-recipes/`, `workflows/`, and `~/.pi/agent/workflow-recipes/`, `/workflow` fails closed.

## Recipes

| Recipe | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize + foreach verifier + reduce + ask continuation | Research needs source-backed claims, dynamic breadth/depth, independent verification, citations, or bounded follow-up. Supports `quick`, `standard`, and `max` depth through task wording/input. |
| `deep-review` | `scout` | cheap triage + foreach review lenses + foreach devil's advocate + reduce, read-only | Thorough/panel review where findings should be independently challenged before synthesis. |
| `migration` | `scout` | parallel inventory + normalize/dedupe + foreach item plans + reduce, read-only | Large migration/port/refactor planning with ordered phases and independently reviewable work items. |
| `implement` | `scout`, `delegate` | task plan + validation baseline + foreach managed-worktree implementation + reduce | Bounded implementation batches when sensitive-work policy is known and validation expectations should be explicit before edits. |
| `best-of-n-fix` | `delegate`, `scout` | read-only normalize + foreach managed-worktree attempts + reduce | Expensive workflow for genuinely uncertain fixes where multiple isolated approaches should be compared. Human selects; no auto-merge. |
| `revise-loop` | `scout` | draft + evaluate + revise + evaluate + final, read-only | Improve a draft artifact, plan, prompt, ADR, or similar output with a bounded evaluator-optimizer loop. |
| `decision-debate` | `scout` | frame + proposer/opposition/pragmatist + cross-examine + judge, read-only | Stress-test design decisions, ADRs, API/UX choices, and tradeoff-heavy plans. |

`deep-research`, `deep-review`, `migration`, `revise-loop`, and `decision-debate` are read-only by default. `implement` and `best-of-n-fix` are write-capable exceptions: implementation attempts use a `delegate` agent in managed worktrees without `bash`, while comparison/review remains read-only and requires a human merge decision. All recipes rely on agent tool ceilings and `/workflow` validation to fail closed if the required agent is unavailable or cannot provide the requested tools. Critic/judge/vote outputs are evidence surfaces, not truth or permission to auto-fix.
