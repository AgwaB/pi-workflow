# Changelog

## Unreleased

### Breaking

- `schemaVersion: 1` is the artifact-graph public workflow contract.
- Bundled starter workflows use `artifactGraph.stages` and vNext `<control>/<analysis>/<refs>` output sections.
- Draft pre-launch authoring/runtime code paths were removed before public launch.

### Added

- Engine-authored vNext artifact bundles: `control.json`, `analysis.md`, `refs.json`, `raw.md`, and `result.json`.
- `workflow_artifact` source manifest/read-ledger tool integration for artifact-graph tasks.
- `inputPolicy.requiredReads` fail-closed enforcement backed by the workflow artifact read ledger.
- Workflow-local `output.controlSchema` JSON Schema subset validation.
- `sourceProjection` inline control-plane projections for compact downstream source context.
- Public artifact-graph versions of all bundled starter workflows.
- Consumer-install CLI smoke coverage in e2e.

### Changed

- Deterministic foreach, loop, and support-helper inputs read upstream `control.json` instead of prose analysis.
- Bundled workflow docs and examples now document `artifactGraph.stages`.
