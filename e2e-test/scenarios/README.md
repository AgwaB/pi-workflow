# pi-subagent-flow E2E scenarios

These scenarios are intended to be run from the project root with the local extension loaded:

```bash
pi --offline --no-session --no-context-files --no-skills --no-prompt-templates --no-themes -e "$PWD" -p "/flow validate e2e-test/scenarios/01-single-token.json"
pi --offline --no-session --no-context-files --no-skills --no-prompt-templates --no-themes -e "$PWD" -p "/flow run e2e-test/scenarios/01-single-token.json"
```

Positive scenarios run real Pi child agents through tmux. schemaVersion 2 runtime scenarios must be launched with a task string, for example `/flow run e2e-test/scenarios/29-stage-task-parallel.json "Run this e2e scenario. Follow the stage instructions exactly."`. Invalid scenarios are validation-only and should fail closed.

Before scenarios that require managed git worktrees, prepare the fixture from a fresh clone:

```bash
e2e-test/setup-fixtures.sh
```

Before scenarios that require managed git worktrees, prepare the fixture from a fresh clone:

```bash
e2e-test/setup-fixtures.sh
```

Before scenarios that require managed git worktrees, prepare the fixture from a fresh clone:

```bash
e2e-test/setup-fixtures.sh
```

Before scenarios that require managed git worktrees, prepare the fixture from a fresh clone:

```bash
e2e-test/setup-fixtures.sh
```

## Positive / runtime scenarios

1. `01-single-token.json` — single real Pi child agent.
2. `02-parallel-tokens.json` — two real Pi child agents in parallel.
3. `03-chain-context.json` — chain context from step 1 to step 2.
4. `04-role-injection.json` — deterministic project-local role context injected into a real child task.
5. `05-managed-worktree-git.json` — explicit managed worktree from `e2e-test/fixtures/worktree-base`.
6. `06-blocked-on-request.json` — mutation-capable task with `worktreePolicy: "off"` launches without a managed worktree.
7. `07-worktree-nongit-fail.json` — required managed worktree is created from the project git root.
8. `08-bootstrap-cwd-fail.json` — project-root cwd bootstrap succeeds for a read-only task.
9. `09-auto-worktree-mutation.json` — auto-managed worktree for mutation-capable task.
10. `10-chain-failure-skip.json` — failed first chain step skips later steps.
11. `11-timeout.json` — `maxRuntimeMs` timeout reconciliation.
12. `12-unknown-custom-tool-blocked.json` — recipe-local `external-mutation` custom tool blocks as `needs_attention`.
13. `13-status-reconciles-without-wait.json` — global status reconciles child result artifacts without `/flow wait`.
14. `e2e-single-recipe` — exact named recipe under `flows/e2e-single-recipe.yaml` validates and runs.
14. `e2e-single-recipe` — exact named recipe under `flows/e2e-single-recipe.yaml` validates and runs.
14. `e2e-single-recipe` — exact named recipe under `flows/e2e-single-recipe.yaml` validates and runs.
14. `e2e-single-recipe` — exact named recipe under `flows/e2e-single-recipe.yaml` validates and runs.

## Invalid validation scenarios

- `invalid/invalid-agent-path.json`
- `invalid/invalid-tool-expansion.json`
- `invalid/invalid-delegation-tool.json`
- `invalid/invalid-cwd-outside-root.json`
- `invalid/invalid-high-concurrency.json`
- `invalid/invalid-map-duplicate-item.json`
- `invalid/invalid-map-duplicate-item.json`
- `invalid/invalid-map-duplicate-item.json`
- `invalid/invalid-map-duplicate-item.json`
- `invalid/invalid-dag-cycle.json`
- `invalid/invalid-dag-missing-dependency.json`
- `invalid/invalid-dag-cycle.json`
- `invalid/invalid-dag-missing-dependency.json`
- `invalid/invalid-dag-cycle.json`
- `invalid/invalid-dag-missing-dependency.json`
- `invalid/invalid-dag-cycle.json`
- `invalid/invalid-dag-missing-dependency.json`
- `invalid/invalid-yaml-anchor.yaml`
- `invalid/invalid-yaml-anchor.yaml`
- `invalid/invalid-yaml-anchor.yaml`
- `invalid/invalid-yaml-anchor.yaml`
- `invalid/invalid-one-task-parallel.json`
- `invalid/invalid-no-tools-agent-expansion.json`
- `invalid/invalid-agent-symlink-escape.json`
- `invalid/invalid-route-unknown.json`
- `invalid/invalid-join-multiple.json`
- `invalid/invalid-retry-high-attempts.json`
- `invalid/invalid-tree-cycle.json`
- `invalid/invalid-route-unknown.json`
- `invalid/invalid-join-multiple.json`
- `invalid/invalid-retry-high-attempts.json`
- `invalid/invalid-tree-cycle.json`
- `invalid/invalid-route-unknown.json`
- `invalid/invalid-join-multiple.json`
- `invalid/invalid-retry-high-attempts.json`
- `invalid/invalid-tree-cycle.json`
- `invalid/invalid-route-unknown.json`
- `invalid/invalid-join-multiple.json`
- `invalid/invalid-retry-high-attempts.json`
- `invalid/invalid-tree-cycle.json`
