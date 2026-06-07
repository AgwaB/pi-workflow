# pi-subagent-flow E2E checklist

Purpose: exercise `/flow` as a real Pi user would, including real tmux-launched Pi child agents for positive scenarios.

## Environment
- Project: `/Users/toby/pi/pi-subagent-flow`
- Extension load command: `pi --offline --no-session --no-context-files --no-skills --no-prompt-templates --no-themes -e "$PWD" -p "<flow command>"`
- Positive scenarios run actual child Pi agents via `/flow run`.
- Run all scenarios with `npm run e2e`.
- Run all scenarios with `npm run e2e`.
- Run all scenarios with `npm run e2e`.
- Run all scenarios with `npm run e2e`.
- Reports/evidence are kept under `e2e-test/results/` and `.pi/flows/<run-id>/`.

## Scenarios
- [x] 01 single read-only agent returns a deterministic token.
- [x] 02 parallel read-only agents run together and return distinct tokens.
- [x] 03 chain passes previous output context to step 2.
- [x] 04 role injection exposes `backend-expert` safe context to the task.
- [x] 05 managed worktree is created from a real git fixture and the child agent runs there.
- [x] 06 mutation-capable `on-request` background task is blocked instead of auto-approved.
- [x] 07 required worktree fails closed when cwd cannot be used as a git source.
- [x] 08 invalid cwd bootstrap writes a failed task result instead of hanging.
- [x] 09 mutation-capable `worktreePolicy:auto` task is isolated in a managed worktree.
- [x] 10 failed chain step marks later step `skipped/skipped_after_failure`.
- [x] 11 `maxRuntimeMs` timeout marks task `failed/timeout`.
- [x] 12 unknown/custom tool task is blocked as `needs_attention`.
- [x] 13 global `/flow status` reconciles child result artifacts without `/flow wait`.
- [x] 14 parallel aggregate receives completed/failed task status and output context.
- [x] 15 explicit DAG roots run before dependent join with dependency context.
- [x] 16 static map items expand into child tasks and aggregate output previews.
- [x] YAML example validates through the same `/flow validate` path.
- [x] named recipe validates and runs through exact recipe resolution.
- [x] named recipe validates and runs through exact recipe resolution.
- [x] named recipe validates and runs through exact recipe resolution.
- [x] named recipe validates and runs through exact recipe resolution.
- [x] invalid agent path validation fails closed.
- [x] invalid tool expansion validation fails closed.
- [x] invalid high concurrency validation fails closed.
- [x] invalid one-task parallel validation fails closed.
- [x] invalid tools granted to no-tools agent fails closed.
- [x] invalid symlinked agent escape fails closed.
- [x] invalid DAG cycle fails closed.
- [x] invalid DAG missing dependency fails closed.
- [x] invalid DAG cycle fails closed.
- [x] invalid DAG missing dependency fails closed.
- [x] invalid DAG cycle fails closed.
- [x] invalid DAG missing dependency fails closed.
- [x] invalid DAG cycle fails closed.
- [x] invalid DAG missing dependency fails closed.
- [x] invalid YAML anchor fails closed.
- [x] invalid YAML anchor fails closed.
- [x] invalid YAML anchor fails closed.
- [x] invalid YAML anchor fails closed.

## Teardown
- [x] Confirm no tmux panes remain in the project directory after scenarios finish.
- [x] Confirm no `.pi/flows/**/*.lock` files remain after scenarios finish.
- [x] Keep report and scenario files.
