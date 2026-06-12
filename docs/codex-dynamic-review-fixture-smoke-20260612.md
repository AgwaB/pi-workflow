# OpenAI Codex dynamic-review fixture smoke (2026-06-12)

## Target

- Repository: `https://github.com/openai/codex.git`
- Pinned commit: `7cc80b39f1247beb9319228d9b3129c510763914`
- Package focus: `codex-rs/tools`
- Registry: `.pi/eval/dynamic-review/tasks.codex-tools-smoke.json`
- Regression patch: `.pi/eval/dynamic-review/fixtures/codex-tools-loadable-tool-regressions/regression.patch`
- Private key: `private://codex-tools-loadable-tool-regressions-dynamic-review-v1.json`

## Fixture shape

The runner-applied patch contains two behavior regressions plus two benign/noise hunks:

1. `responses_api::coalesce_loadable_tool_specs` matches duplicate namespaces by description instead of stable namespace name.
2. `tool_search::ToolSearchInfo::from_spec` leaves child namespace tool `output_schema` populated after marking the tool as deferred.
3. Noise: `json_schema.rs` comment wording around schema byte-budget proxy.
4. Noise: `mcp_tool.rs` JSON object member order for `structuredContent` / `isError`.

Existing upstream `codex-tools` tests pass with the regression patch applied, so candidates must add targeted regression tests rather than relying on exact pre-existing tests.

## Manual RED/GREEN checks

Temporary tests (not included in the fixture) produced RED on the patched source:

```text
cargo test -p codex-tools -- --nocapture
responses_api::tests::coalesces_duplicate_loadable_namespaces_by_name_not_description ... FAILED
  expected duplicate namespace names to be merged; got two mcp__calendar namespaces

tool_search::tests::namespace_search_output_defers_children_and_strips_output_schema ... FAILED
  expected output_schema None; got Some({...})
```

After restoring the source behavior, the same targeted tests passed:

```text
cargo test -p codex-tools coalesces_duplicate_loadable_namespaces_by_name_not_description -- --nocapture
cargo test -p codex-tools namespace_search_output_defers_children_and_strips_output_schema -- --nocapture
```

## Runner smoke / calibration status

Kimi-low plain-arm plumbing smoke:

```text
.pi/eval/dynamic-review/runs/run-20260612T201011Z
arm B plain: score 12/12, trap penalty 0, command runs 6
```

This is a calibration/smoke fixture, not a pristine blind holdout. The B-arm smoke exposed a general Rust plumbing gap in the scorer: Rust test files such as `*_tests.rs` were not recognized as test artifacts. That language-support fix is now in the runner. For a strict holdout claim, freeze a second Codex fixture after this plumbing change and do not tune scorer/workflow/prompt/matcher from its outputs.

## Notes

- Target cache install command: `cd codex-rs && cargo test -p codex-tools --no-run`.
- `dependencyArtifactPaths: ["codex-rs/target"]` keeps the heavy Rust target directory in the cache and symlinks it into arm workspaces.
- On this machine, `codex-rs/target` is large (~14 GB); use `PI_WORKFLOW_DYNAMIC_EVAL_TARGET_CACHE` or manual cleanup if disk pressure matters.
