# pi-subagent-flow roadmap

This roadmap tracks post-MVP work. The current MVP remains deterministic spec-file/recipe + tmux-first local execution via `/flow run <spec.json|yaml|recipe-name>`.

## Latest research alignment

The 2026-05 subagent research update does **not** justify a broad new orchestration engine. The current explicit-spec direction remains the right default:

- keep parent-owned scheduling and visible artifacts;
- keep no child self-delegation / no nested delegation by default;
- keep tool ceilings, blocked approval states, and worktree isolation for mutation-capable work;
- avoid hidden natural-language fan-out and generic team mode.

Near-term functional additions should stay narrow:

1. **Oracle / critic recipe** — read-only stronger-model review/verification, evidence-first, no edits.
2. **Best-of-N + managed worktree recipe** — implemented as a named recipe with isolated attempts and human selection; no auto-merge.
3. **Budget / fan-out guard** — static token/cost estimates now exist using spec-supplied model rates; provider usage reconciliation remains future work.

Deferred unless strong dogfood demand appears: nested delegation, dynamic router, autonomous orchestrator-workers, agent-to-agent messaging, arbitrary workflow scripts, cloud fleet management.

## Stage-first v2 design direction

A stage-first schemaVersion 2 proposal is tracked in [`FLOW_V2_PROPOSAL.md`](./FLOW_V2_PROPOSAL.md). The initial v2 launch contract is now implemented for `task`, `parallel`, `foreach`, `reduce`, and linked continuation child runs. Existing schemaVersion 1 behavior remains an internal MVP surface with no compatibility guarantee. v2 is the intended launch contract; existing schemaVersion 1 behavior is an internal MVP detail with no compatibility guarantee. v2 is the intended launch contract; existing schemaVersion 1 behavior is an internal MVP detail with no compatibility guarantee. v2 is the intended launch contract; existing schemaVersion 1 behavior is an internal MVP detail with no compatibility guarantee.

Key direction:

- `flow.stages` replaces top-level `flow.type` in v2.
- Initial v2 stage types: `task`, `parallel`, `reduce`, and `foreach`.
- Agent-declared tools remain the hard ceiling; flow/stage/task `tools` only narrow that ceiling.
- Dynamic continuation is stage-local via `stage.continuation` and top-level `nextFlowSpec` in that stage's JSON structured output; initial v2 modes are `auto` and `ask` only.
- `foreach.from` supports deterministic single-output extraction and explicit code-level `mode: "concat"` from multi-task stages; semantic merge/dedupe remains an explicit `reduce` stage.
- `dag` stage support is deferred and does not define the v2 launch contract.
- v2 does not preserve schemaVersion 1 fallback syntax, aliases, recipes, or stored-run compatibility.

Implementation phases:

1. [x] v2 parser/schema validation and schemaVersion 1 launch-contract cleanup.
2. [x] Built-in tool registry, spec-local `toolDefinitions`, readOnly capability checks, and agent-ceiling validation.
3. [x] Stage compiler and top-level/stage/task inheritance.
4. [x] Stage-oriented artifact layout.
5. [x] Stage-first runtime scheduler and stage status aggregation.
6. [x] Reduce context injection.
7. [x] `foreach` extraction/concat expansion from structured output arrays.
8. [x] Stage-local continuation with `nextFlowSpec` child runs (`auto` launches linked child runs; `ask` records `awaiting_approval` and `/flow continue` approves the child run).
9. [x] Codex-like dirty worktree snapshot for managed worktrees.

## Implementation checklist vs `subagent-orchestration-patterns.md`

Legend: `[x] implemented`, `[~] partial / MVP subset`, `[ ] not implemented`.

### Layer 1 — Execution models

- [x] `single`
- [x] `parallel`
- [x] `chain` / pipeline
- [x] async/background run IDs
- [x] `/flow status`
- [x] `/flow logs`
- [x] `/flow wait`
- [x] tmux-backed child Pi execution

### Layer 2 — Splitting / dispatch strategies

- [x] static `map` splitter
- [x] `route` splitter
- [x] static `partition` helper
  - Static partitions are explicit `{ id, input }` slices; dynamic conflict analysis remains out of scope.
  - Mutation-capable partition tasks can still be isolated with managed worktrees.

### Layer 3 — Aggregation / decision strategies

- [x] synchronization join for `parallel`
- [~] raw result collection via task logs/result artifacts
- [~] semantic `aggregate`
  - Optional explicit join tasks (`aggregate`, `judge`, `vote`, `synthesize`, `dedupe`, `select`, `rank`) receive statuses, artifact paths, worktree paths, and short output previews. They remain explicit subagent tasks, not hidden semantic evaluators.
- [x] `synthesize`
- [x] `dedupe`
- [x] `vote`
- [x] `judge`
- [x] `select` / best-result selection
  - Explicit `select` and `rank` helpers prepare evidence surfaces for human selection; no hidden auto-merge.

### Layer 4 — Control strategies

- [x] chain stop-on-first-failure
- [x] blocked states for approval/tool issues
- [x] `maxRuntimeMs` timeout reconciliation
- [x] retry
- [ ] loop
- [x] until-pass
- [ ] until-dry
- [~] budget / fan-out guard
  - Compile warnings cover task count, concurrency, runtime ceilings, and optional static token/cost estimates using spec-supplied provider/model rates. Provider-reported usage reconciliation remains future work.
  - Dynamic `foreach` fan-out preview/approval is deferred; current stage-first runtime expands all extracted items and uses `maxConcurrency` only as a refill limit.
  - Dynamic `foreach` fan-out preview/approval is deferred; current stage-first runtime expands all extracted items and uses `maxConcurrency` only as a refill limit.
  - Dynamic `foreach` fan-out preview/approval is deferred; current stage-first runtime expands all extracted items and uses `maxConcurrency` only as a refill limit.
  - Dynamic `foreach` fan-out preview/approval is deferred; current stage-first runtime expands all extracted items and uses `maxConcurrency` only as a refill limit.
- [ ] iteration cap
- [~] human gate
  - Represented as `blocked/pending_approval`, but no interactive approval flow yet.

### Layer 5 — Workflow topology

- [x] linear topology via `chain`
- [x] manual fan-out via `parallel`
- [~] fan-out/fan-in
  - Fan-out plus synchronization join and optional explicit aggregate/judge/vote/synthesize/dedupe/select/rank task.
- [x] tree topology
- [x] general DAG
- [ ] cyclic control loop

### Layer 6 — Orchestration patterns

- [~] fan-out/fan-in
  - Parallel execution plus optional explicit aggregate task.
- [ ] map-reduce
- [x] routed fan-out
- [x] pipeline via `chain`
- [~] best-of-n + managed worktrees
  - Available as a named recipe with managed implementation worktrees and read-only comparison; no auto-merge.
- [~] oracle / critic verification
  - Available as a read-only named recipe; no hidden truth oracle or auto-fix behavior.
- [ ] evaluator-optimizer
- [ ] orchestrator-workers
  - Deferred: dynamic/autonomous orchestrator-workers are not needed for the current explicit-spec product direction.
- [~] planner-executor-checker
  - Possible manually with `chain`, but no first-class pattern helper.

### Layer 7 — Product recipes

- [~] code-research example recipe
- [~] backend role-injection example recipe
- [x] named recipe registry
- [x] `/flow recipe ...`
- [x] oracle-critic recipe
- [x] best-of-n-worktree recipe
- [ ] deep-research recipe
- [ ] auto-review recipe migration
- [ ] implementation-slice recipe
- [ ] qa-gate recipe
- [ ] migration-flow recipe
- [ ] best-of-n-fix recipe

### Agent roles

- [x] Pi agent discovery
- [x] agent frontmatter parsing
- [x] role injection from `fromAgent`
- [x] safe-section extraction
- [x] tool ceiling validation
- [x] no-delegation MVP boundary
- [~] read-only critic/verifier role recipe
  - Covered by the `oracle-critic` recipe using existing read-only agent/tool ceilings.
- [ ] dynamic router role
  - Deferred until static route/partition/map and explicit specs prove insufficient.
- [ ] synthesizer role as first-class aggregation step

### Runtime / safety / UX

- [x] tmux-first backend
- [x] fail-closed backend behavior
- [x] managed worktrees under `.pi/flows/<run-id>/worktrees/<task-id>/`
- [x] max concurrency
- [x] run leases
- [x] stale lock handling
- [x] canonical `run.json`
- [x] compact `.pi/flows/index.json`
- [x] task logs/results/stderr artifacts
- [x] E2E scenarios with real Pi child agents
- [~] budget / fan-out guard surface
  - Includes static token/cost budget limits with `warn` or `block` behavior; live provider usage is not reconciled yet.
  - Includes static token/cost budget limits with `warn` or `block` behavior; live provider usage is not reconciled yet.
  - Includes static token/cost budget limits with `warn` or `block` behavior; live provider usage is not reconciled yet.
  - Includes static token/cost budget limits with `warn` or `block` behavior; live provider usage is not reconciled yet.
- [ ] pi-panel UI integration
- [ ] deeper `pi-worktree-flow` integration

### Command surface comparison

Implemented:

- [x] `/flow run <spec.json|yaml|recipe-name>`
- [x] `/flow validate <spec.json|yaml|recipe-name>`
- [x] `/flow roles <spec.json|yaml|recipe-name>`
- [x] `/flow agents`
- [x] `/flow status [run-id]`
- [x] `/flow show <run-id>`
- [x] `/flow logs <run-id> [task-id] [lines]`
- [x] `/flow wait <run-id> [timeout-ms]`

Not implemented from the pattern note:

- [ ] `/flow run <agent> "<task>"`
- [ ] `/flow parallel <spec-file>`
- [ ] `/flow chain <spec-file>`
- [ ] `/flow map <spec-file>`
- [ ] `/flow route <spec-file>`
- [ ] `/flow pattern ...`
- [x] `/flow recipe ...`
- [ ] `/deep-research ...`

### Summary

Implemented the core execution engine:

- `single`
- `parallel`
- `chain`
- `dag`
- `dag`
- `dag`
- `dag`
- async run/status/logs/wait
- artifacts
- role injection
- safety/worktree/permission handling

Not implemented yet:

- dynamic/conflict-aware partitioning beyond static partition slices
- hidden semantic synthesis beyond explicit join tasks
- loops beyond bounded retry/until-pass
- cyclic control loops
- product-level recipes like deep research or auto-review migration

## Deferred review follow-ups

The `REVIEW.md` pass raised a few modularity improvements that are intentionally deferred to avoid over-engineering the MVP before a second backend or richer topology exists:

- FlowBackend adapter interface and backend-neutral handles for `paneId`/`pid`.
- General DAG/tree topology and pattern-level orchestration APIs.
- First-class semantic aggregation/judge/vote helpers beyond raw result artifacts.

These should be revisited when implementing a non-tmux backend, DAG topology, or aggregation helpers.

## Deferred review follow-ups

The `REVIEW.md` pass raised a few modularity improvements that are intentionally deferred to avoid over-engineering the MVP before a second backend or richer topology exists:

- FlowBackend adapter interface and backend-neutral handles for `paneId`/`pid`.
- General DAG/tree topology and pattern-level orchestration APIs.
- First-class semantic aggregation/judge/vote helpers beyond raw result artifacts.

These should be revisited when implementing a non-tmux backend, DAG topology, or aggregation helpers.

## Deferred review follow-ups

The `REVIEW.md` pass raised a few modularity improvements that are intentionally deferred to avoid over-engineering the MVP before a second backend or richer topology exists:

- FlowBackend adapter interface and backend-neutral handles for `paneId`/`pid`.
- General DAG/tree topology and pattern-level orchestration APIs.
- First-class semantic aggregation/judge/vote helpers beyond raw result artifacts.

These should be revisited when implementing a non-tmux backend, DAG topology, or aggregation helpers.

## Deferred review follow-ups

The `REVIEW.md` pass raised a few modularity improvements that are intentionally deferred to avoid over-engineering the MVP before a second backend or richer topology exists:

- FlowBackend adapter interface and backend-neutral handles for `paneId`/`pid`.
- General DAG/tree topology and pattern-level orchestration APIs.
- First-class semantic aggregation/judge/vote helpers beyond raw result artifacts.

These should be revisited when implementing a non-tmux backend, DAG topology, or aggregation helpers.

## Current priorities

### P0 — Keep MVP stable and research-aligned

Goal: avoid expanding into generic team-mode or hidden orchestration while preserving the current deterministic safety model.

Scope:
- Update public docs to distinguish context isolation, filesystem/worktree isolation, and tool/permission isolation.
- Document that `tree` is a supervisor-owned explicit tree/DAG topology, not child-spawned nested delegation.
- Keep Copilot Fleet-style shared-filesystem parallelism out of the safety model; Pi mutation-capable fan-out should use managed worktrees or fail closed.
- Treat multi-agent coding speed/quality claims as caveated until Pi has its own dogfood benchmarks.

Acceptance criteria:
- README/roadmap language does not imply subagents are sandboxes.
- No roadmap item requires nested delegation, dynamic router, or team messaging for core value.

### P2 — Provider usage/cost reconciliation

Goal: optionally reconcile static budget estimates with provider-reported usage when child Pi JSON events expose reliable provider/model usage across backends.

Candidate shape:
- Keep current `budget.maxEstimatedTokens`, `budget.maxEstimatedUsd`, `budget.modelRates`, and `onExceed` as deterministic preflight limits.
- Add post-run usage/cost summaries only when provider usage events are trustworthy.

Acceptance criteria:
- Existing small recipes remain unchanged.
- Static token/cost estimates stay clearly labeled and fail closed only when explicitly configured.

### P2 — Release hygiene and regression confidence

Goal: keep the current MVP reliable while preparing for broader dogfood.

Candidate work:
- Maintain the repeatable `npm run e2e` runner that sets up fixtures, runs scenarios, and writes a compact report.
- Maintain fast unit tests for schema/compiler/store edge cases where deterministic checks are enough.
- Maintain fixture setup for git worktree tests so fresh clones can run E2E without preserving nested `.git` directories.
- Keep public package tarball free of local `.pi/`, `.memory/`, and E2E result artifacts.

Acceptance criteria:
- One command can run the core validation and E2E scenario set from a fresh clone.
- Typecheck, unit tests, pack dry-run, and scenario validation remain green.

## Completed milestones

### YAML spec support

Goal: support YAML specs without weakening deterministic validation.

Constraints:
- JSON remains the canonical documented spec shape.
- YAML parsing must compile to the same internal `FlowSpec` and validation path.
- Unsupported YAML features must fail closed with clear errors.

Status:
- Implemented a conservative fail-closed `.yaml`/`.yml` parser that feeds the same `FlowSpec` validation path as JSON.
- `/flow validate spec.yaml` and `/flow run spec.yaml` work for equivalent examples.
- Anchors, aliases, tags, merge keys, multiple documents, and advanced block scalar modifiers are rejected.
- Existing JSON scenarios remain unchanged.

### Named recipe registry

Goal: allow deterministic recipe names without natural-language auto-selection.

Status:
- Project registries: `.pi/flow-recipes/*.{json,yaml,yml}` and `flows/*.{json,yaml,yml}`.
- User registry: `~/.pi/agent/flow-recipes/*.{json,yaml,yml}`.
- `/flow validate <recipe-name>`, `/flow roles <recipe-name>`, and `/flow run <recipe-name>` resolve exact filename aliases only and print the resolved path.
- `/flow recipe list` and `/flow recipe show <recipe-name>` expose deterministic recipe discovery without natural-language selection.
- Ambiguous names fail closed; no natural-language inference or hidden selection.

### Aggregation/synthesis helper — partial

Goal: add a simple deterministic post-parallel collection step.

Candidate shape:
- Optional `aggregate` task for `parallel` flows.
- Aggregator receives output paths and short previews, not full raw logs by default.
- Aggregator is just another explicit agent task with normal tool/runtime/worktree rules.

Status:
- Implemented optional `flow.aggregate` for `parallel` flows.
- Parallel task statuses, artifact paths, and short output previews are appended to the aggregate task prompt.
- Aggregator launch is visible in `run.json`/status via `kind=aggregate`.
- Failed main tasks are represented in aggregate context; blocked main tasks keep the flow blocked and do not launch aggregation.

### E2E and review recipe library

Goal: ship useful example flows without replacing existing harness or auto-review skills.

Status:
- Added deterministic JSON named recipes under `flows/`:
  - `quick-check`
  - `code-research`
  - `focused-review`
  - `oracle-critic`
  - `discover-verify-summarize`
  - `public-readiness`
- `flows/README.md` documents required agents, mode, and expected outputs.
- Recipes are read-only by default and validate through the named recipe registry.

### Oracle / critic recipe

Goal: add a narrow read-only second-opinion workflow inspired by Oracle/critic patterns.

Status:
- Added `flows/oracle-critic.json` as a parallel critic/verifier flow with an aggregate triage task.
- The recipe uses `ORACLE_CRITIC_TARGET.md` when present; otherwise it inspects the package docs/source/test surface.
- Output contracts require evidence, file paths, severity/action classification, uncertainty, and no edits or auto-fixes.

### Best-of-N + managed worktree recipe

Goal: support isolated alternative implementations without adding a new engine primitive.

Status:
- Added `flows/best-of-n-worktree.json` with three `delegate` implementation attempts using `worktreePolicy: "on"` and a read-only `scout` comparison task.
- The recipe reads `BEST_OF_N_TASK.md` as the explicit task contract; if missing, attempts must not modify files.
- Comparison receives branch statuses, artifacts, output previews, and worktree paths, then recommends a winner or no-winner for human selection. `/flow` never auto-merges.

### DAG topology

Goal: support explicit non-linear dependency graphs after single/parallel/chain semantics are stable.

Constraints:
- No general autonomous scheduler until simpler primitives are exhausted.
- DAG nodes remain explicit tasks; edges are explicit dependencies.
- Cycles and unreachable nodes fail validation.

Status:
- Added `flow.type: "dag"` with explicit task `id` and optional `dependsOn` arrays.
- DAG validation catches missing IDs, duplicate IDs, missing dependencies, self-dependencies, and cycles.
- Scheduler launches dependency-ready tasks up to `maxConcurrency` and applies normal worktree/tool safety rules.
- Dependent tasks receive dependency statuses, artifact paths, and short output previews.
- Failed/skipped dependencies skip pending dependents with `skipped_after_dependency_failure`.

### Structured output contracts

Status:
- Task-level `output.format` supports `text`, `markdown`, and strict `json` validation.
- JSON output can require top-level keys and either fail (`failed/output_invalid`) or warn on invalid output.
- Valid structured output is persisted to task `result.json` as `structuredOutput`; raw output remains in `output.log`.

### Structured output contracts

Status:
- Task-level `output.format` supports `text`, `markdown`, and strict `json` validation.
- JSON output can require top-level keys and either fail (`failed/output_invalid`) or warn on invalid output.
- Valid structured output is persisted to task `result.json` as `structuredOutput`; raw output remains in `output.log`.

### Structured output contracts

Status:
- Task-level `output.format` supports `text`, `markdown`, and strict `json` validation.
- JSON output can require top-level keys and either fail (`failed/output_invalid`) or warn on invalid output.
- Valid structured output is persisted to task `result.json` as `structuredOutput`; raw output remains in `output.log`.

### Structured output contracts

Status:
- Task-level `output.format` supports `text`, `markdown`, and strict `json` validation.
- JSON output can require top-level keys and either fail (`failed/output_invalid`) or warn on invalid output.
- Valid structured output is persisted to task `result.json` as `structuredOutput`; raw output remains in `output.log`.

### Advanced helpers

Completed:
- static map splitter
- static route splitter
- static partition helper
- static partition helper
- static partition helper
- static partition helper
- explicit aggregate/judge/vote/synthesize/dedupe/select/rank join helpers
- bounded retry helper
- bounded until-pass helper
- bounded until-pass helper
- bounded until-pass helper
- bounded until-pass helper
- tree topology

Defer until real dogfood proves demand:
- loop-until-dry
- first-class pi-panel UI integration
- deeper pi-worktree-flow integration
- harness migration

## Non-goals to preserve

- No implicit backend fallback.
- No hidden natural-language recipe selection.
- No tool expansion beyond agent-declared ceilings.
- No parallel shared-cwd mutation by default.
- No auto-publish/deploy behavior from `/flow`.
