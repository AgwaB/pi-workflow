> Historical archive. Non-authoritative. Preserved for recovery context only.
> Current public terminology is workflow / workflow spec / workflow file / workflow run.

# pi-subagent-workflow library

These workflows are deterministic named `/workflow` templates. A workflow defines structure and role prompts; the concrete task is supplied at runtime.

Run them from the project root by exact filename alias, for example:

```text
/workworkflow list
/workworkflow show code-research
/workflow validate code-research
/workworkflow run code-research "Map the /workworkflow run command path and artifact lifecycle."
```

Runtime selection is explicit: `/workworkflow run` takes an exact workflow name or explicit path plus a task string. Parent agents can use `/workflow recommend "<request>"` as a hidden/helper step to score workflow `catalog` metadata and choose a deterministic starting point. If a name is ambiguous across `.pi/workworkworkflows/`, `workflows/`, and `~/.pi/agent/workworkworkflows/`, `/workflow` fails closed.

## Workflows

| Workflow | Required agents | Mode | Expected output |
|---|---|---|---|
| `quick-check` | `scout` | stage-first task, read-only | Exact response requested by the runtime task; used by E2E as a workflow smoke check. |
| `code-research` | `scout` | stage-first parallel + reduce, read-only | Source-backed implementation map for the runtime research objective. |
| `focused-review` | `scout` | stage-first parallel + reduce, read-only | Evidence-backed findings grouped by runtime safety, API/docs consistency, and release hygiene. |
| `review` | `delegate` | stage-first task, review-only bash in managed worktree | Standard single-review contract with git diff/status inspection, structured verdict, findings, evidence, and recommended next action. |
| `deep-review` | `scout` | stage-first parallel + foreach + reduce, read-only | Review fan-out, finding verification, and final evidence-backed synthesis. |
| `oracle-critic` | `scout` | stage-first parallel + reduce, read-only | Evidence-backed second opinion and skeptical verification for the runtime target. |
| `best-of-n-worktree` | `delegate`, `scout` | stage-first parallel managed worktrees + reduce | Three isolated implementation attempts, then read-only comparison; human selects, no auto-merge. |
| `discover-verify-summarize` | `scout` | stage-first task + reduce + reduce, read-only | Discover facts, verify them, and summarize an answer for the runtime task. |
| `public-readiness` | `scout` | stage-first parallel + reduce, read-only | Public-readiness decision summary with must-fix/should-fix/defer sections. |
| `deep-research` | `researcher` | stage-first parallel + foreach + reduce + ask continuation | Research claims, verify them, and synthesize a cited final report with optional bounded next round. |
| `implementation-slice` | `scout`, `delegate` | stage-first task + foreach managed worktrees + reduce | Plan bounded implementation slices, run them in managed worktrees, then review outputs. |
| `migration` | `scout` | stage-first parallel + foreach + reduce | Inventory migration concerns, plan each item, and synthesize migration phases. |
| `best-of-n-fix` | `delegate`, `scout` | stage-first parallel managed worktrees + reduce | Three isolated fix attempts and read-only comparison; human selects, no auto-merge. |

Most workflows are read-only by default. `review` is review-only but bash-capable: it uses `delegate` with `bash` for non-mutating inspection commands such as `git status` and `git diff`, and `/workflow` isolates it in a managed worktree because `bash` is mutation-capable. `best-of-n-worktree`, `implementation-slice`, and `best-of-n-fix` are write-capable exceptions: implementation attempts use a `delegate` agent in managed worktrees, while comparison remains read-only and requires a human merge decision. All workflows rely on agent tool ceilings and `/workflow` validation to fail closed if the required agent is unavailable or cannot provide the requested tools. Critic/judge/vote outputs are evidence surfaces, not truth or permission to auto-fix.

## Review wrapper mapping

A review skill or parent-agent wrapper should keep the user-facing review UX while delegating deterministic execution to these workflows:

- Default ordinary review request → `review`
- User asks for deep/thorough/panel/multi-provider verification → `deep-review`
- User asks for a targeted runtime/API/docs/release triage → `focused-review`

The wrapper should pass the review target as the `/workworkflow run <workflow> "<task>"` runtime task, then package the resulting JSON/Markdown artifacts into the review skill's normal report format. The wrapper should not edit files during review flows.
