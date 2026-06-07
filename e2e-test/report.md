# pi-subagent-flow real E2E test report

Date: 2026-05-30

## Summary

Result: PASS

- Runtime/control scenarios: 13 total, 13 passed
- Validation-only invalid scenarios: 6 total, 6 failed closed as expected
- Real child Pi agent scenarios covered: `single`, `parallel`, `chain`, role injection, managed worktree, auto worktree, status reconciliation without wait
- Expected control/failure scenarios covered: blocked approval, unknown custom tool block, worktree fail-closed, missing cwd bootstrap failure, chain failure skip, runtime timeout
- Remaining project tmux panes after test: 0
- Remaining `.pi/flows/**/*.lock` files after test: 0

## Environment

- Project root: `/Users/toby/pi/pi-subagent-flow`
- Parent invocation shape:
  ```bash
  pi --offline --no-session --no-context-files --no-skills --no-prompt-templates --no-themes -e "$PWD" -p "<flow command>"
  ```
- Positive runtime tests used `/flow run <scenario.json>`, which launched actual child `pi` agents through tmux.
- Worktree test fixture: `e2e-test/fixtures/worktree-base` is a small real git repository.

## Commands run

- `npm run typecheck`
- `/flow help`
- `/flow validate examples/*.json`
- `/flow validate e2e-test/scenarios/*.json`
- `/flow validate e2e-test/scenarios/invalid/*.json` expecting failure
- `/flow run` + `/flow wait` + `/flow show` + `/flow logs` for runtime scenarios
- `/flow run` without wait followed by global `/flow status` for status/index reconciliation
- `npm run pack:dry`
- post-test lock/pane checks
- final public-readiness microtests for project-root symlink fallback and malformed `tasks:[null]` run records
- final public-readiness microtests for project-root symlink fallback and malformed `tasks:[null]` run records
- final public-readiness microtests for project-root symlink fallback and malformed `tasks:[null]` run records
- final public-readiness microtests for project-root symlink fallback and malformed `tasks:[null]` run records

## Runtime scenario results

| Scenario | Run ID | Expected | Result | Evidence |
|---|---|---:|---:|---|
| `01-single-token.json` | `flow_mprevkk8_08ffa4` | completed + `E2E_SINGLE_OK` | PASS | `e2e-test/results/logs/01-single-token-task-1.log` |
| `02-parallel-tokens.json` | `flow_mprevu8j_75481d` | 2 completed tasks + `E2E_PARALLEL_A_OK` / `E2E_PARALLEL_B_OK` | PASS | `e2e-test/results/logs/02-parallel-tokens-task-1.log`, `task-2.log` |
| `03-chain-context.json` | `flow_mprew4m9_6ebac0` | step 2 sees step 1 token + `E2E_CHAIN_CONTEXT_OK` | PASS | `e2e-test/results/logs/03-chain-context-task-2.log` |
| `04-role-injection.json` | `flow_mprewm1s_5d1083` | role context contains backend phrase + `E2E_ROLE_CONTEXT_OK` | PASS | `e2e-test/results/logs/04-role-injection-task-1.log` |
| `05-managed-worktree-git.json` | `flow_mprewy33_05661b` | managed worktree enabled + `E2E_WORKTREE_GIT_OK` | PASS | `e2e-test/results/05-managed-worktree-git-run.json` |
| `06-blocked-on-request.json` | `flow_mprex8p1_6e1e59` | `blocked/pending_approval`, no pane | PASS | `e2e-test/results/06-blocked-on-request-run.json` |
| `07-worktree-nongit-fail.json` | `flow_mprexb7a_043e7b` | `failed/worktree_failed` outside git | PASS | `e2e-test/results/07-worktree-nongit-fail-run.json` |
| `08-bootstrap-cwd-fail.json` | `flow_mprexdqi_b73004` | terminal failure with missing cwd diagnostic | PASS | `e2e-test/results/08-bootstrap-cwd-fail-run.json` |
| `09-auto-worktree-mutation.json` | `flow_mprfn3c3_d1815c` | mutation-capable `worktreePolicy:auto` task isolated in managed worktree + `E2E_AUTO_WORKTREE_OK` | PASS | `e2e-test/results/09-auto-worktree-mutation-run.json` |
| `10-chain-failure-skip.json` | `flow_mprfndy5_b5a389` | failed first chain step; second step `skipped/skipped_after_failure` | PASS | `e2e-test/results/10-chain-failure-skip-run.json` |
| `11-timeout.json` | `flow_mprfnjsf_80d379` | task exceeding `maxRuntimeMs` becomes `failed/timeout` with exit `124` | PASS | `e2e-test/results/11-timeout-run.json` |
| `12-unknown-custom-tool-blocked.json` | `flow_mprfnn6e_ec7248` | unknown custom tool becomes `blocked/needs_attention`, no pane | PASS | `e2e-test/results/12-unknown-custom-tool-blocked-run.json` |
| `13-status-reconciles-without-wait.json` | `flow_mprfo57r_6bc565` | global `/flow status` reconciles completed result after run command exits without wait | PASS | `e2e-test/results/13-status-reconciles-without-wait-status-excerpt.out` |

## Invalid validation scenarios

All invalid specs failed closed as expected.

| Scenario | Expected diagnostic | Evidence |
|---|---|---|
| `invalid-agent-path.json` | unknown unsafe agent `../AGENTS` | `e2e-test/results/invalid-agent-path-validate.err` |
| `invalid-tool-expansion.json` | `bash` expands `scout` tool ceiling | `e2e-test/results/invalid-tool-expansion-validate.err` |
| `invalid-high-concurrency.json` | `maxConcurrency` must be <= 16 | `e2e-test/results/invalid-high-concurrency-validate.err` |
| `invalid-one-task-parallel.json` | parallel requires at least 2 tasks | `e2e-test/results/invalid-one-task-parallel-validate.err` |
| `invalid-no-tools-agent-expansion.json` | tools cannot be granted to an agent without `tools` frontmatter | `e2e-test/results/invalid-no-tools-agent-expansion-validate.err` |
| `invalid-agent-symlink-escape.json` | symlinked agent file escaping agent root rejected | `e2e-test/results/invalid-agent-symlink-escape-validate.err` |

## Assertion output

See:
- `e2e-test/results/assertions.txt`
- `e2e-test/results/additional-assertions.txt`

All assertions passed:
- deterministic output tokens present
- expected run/task statuses matched
- role context was visible to child task
- managed worktrees were enabled for explicit and auto policies
- blocked scenarios did not create tmux panes
- fail-closed scenarios produced terminal failed records
- global `/flow status` reconciled a completed run without using `/flow wait`

## Final public-readiness microtests

| Check | Expected | Result | Evidence |
|---|---|---:|---|
| Symlinked project `.pi/agents` root with user-global `scout` fallback | validation succeeds via user-global agent, project symlink root skipped | PASS | `e2e-test/results/symlink-root-user-fallback-validate.out` |
| External agent under symlinked project `.pi/agents` root | validation fails as unknown agent | PASS | `e2e-test/results/symlink-root-outside-unknown-validate.err` |
| Malformed run record with `tasks:[null]` | global `/flow status` does not crash | PASS | `e2e-test/results/session-start-null-task-status.out` |

## Final public-readiness microtests

| Check | Expected | Result | Evidence |
|---|---|---:|---|
| Symlinked project `.pi/agents` root with user-global `scout` fallback | validation succeeds via user-global agent, project symlink root skipped | PASS | `e2e-test/results/symlink-root-user-fallback-validate.out` |
| External agent under symlinked project `.pi/agents` root | validation fails as unknown agent | PASS | `e2e-test/results/symlink-root-outside-unknown-validate.err` |
| Malformed run record with `tasks:[null]` | global `/flow status` does not crash | PASS | `e2e-test/results/session-start-null-task-status.out` |

## Final public-readiness microtests

| Check | Expected | Result | Evidence |
|---|---|---:|---|
| Symlinked project `.pi/agents` root with user-global `scout` fallback | validation succeeds via user-global agent, project symlink root skipped | PASS | `e2e-test/results/symlink-root-user-fallback-validate.out` |
| External agent under symlinked project `.pi/agents` root | validation fails as unknown agent | PASS | `e2e-test/results/symlink-root-outside-unknown-validate.err` |
| Malformed run record with `tasks:[null]` | global `/flow status` does not crash | PASS | `e2e-test/results/session-start-null-task-status.out` |

## Final public-readiness microtests

| Check | Expected | Result | Evidence |
|---|---|---:|---|
| Symlinked project `.pi/agents` root with user-global `scout` fallback | validation succeeds via user-global agent, project symlink root skipped | PASS | `e2e-test/results/symlink-root-user-fallback-validate.out` |
| External agent under symlinked project `.pi/agents` root | validation fails as unknown agent | PASS | `e2e-test/results/symlink-root-outside-unknown-validate.err` |
| Malformed run record with `tasks:[null]` | global `/flow status` does not crash | PASS | `e2e-test/results/session-start-null-task-status.out` |

## Package check

`npm run pack:dry` passed. The npm package file allowlist excludes `e2e-test/`, `.pi/`, `.memory/`, and `PLAN.md`, so test/local artifacts and planning notes are not packed.

Evidence: `e2e-test/results/pack-dry-final.log`.

## Issues found

No new failing E2E issues were found in this run.

## Known limitations still applicable

- JSON only; no YAML specs.
- `/flow run <spec.json>` only; no recipe registry or natural-language recipe selection.
- Backend is tmux-first local Pi; `headless` is reserved for later and rejected in the MVP.
- No semantic aggregation/synthesis helper yet.
- `index.json` is a compact status cache; per-run `run.json` remains canonical.
