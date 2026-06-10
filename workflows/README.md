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
| `deep-research` | `researcher` | plan + foreach questions + normalize + foreach verifier + reduce + continuation suggestion | Research needs source-backed claims, dynamic breadth/depth, independent verification, citations, or bounded follow-up. Supports `quick`, `standard`, and `max` depth through task wording/input. |
| `deep-review` | `scout` | cheap triage + foreach review lenses + foreach devil's advocate + reduce, read-only | Thorough/panel review where findings should be independently challenged before synthesis. |

Continuation is not a task/stage type today. Bundled workflow specs may include continuation policy metadata and prompts may emit `nextWorkflow`, but the current compiler/runtime do not automatically launch follow-up rounds.

Deferred workflow candidates live under `internal/plans/deferred-workflows/` and are not bundled workflow surface.
