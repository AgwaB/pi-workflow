# Changelog

## Unreleased

- **feat:** Dynamic decision-loop planner rounds now see a bounded cumulative coordination projection: gaps, blockers, conflicts, omissions, and failed work from prior rounds are folded into a ledger and rendered into the next planner prompt as a deterministic `Coordination state (cumulative): …` block. The direct-dynamic runtime bundle label is bumped to `direct-dynamic-runtime-v2` to reflect the changed prompt shape.
  - **Upgrade caveat:** in-flight dynamic runs started before this change cannot be resumed under the new version — the regenerated planner prompt diverges from the recorded request hash and the run fails closed with the `dynamic agent request changed …` error. Finish or restart such runs before upgrading in place.
  - **Rollback caveat:** reverting is a pure `git revert` with no data migration, but runs started under the new version cannot resume under reverted code for the same fail-closed reason. Restart them after rollback.
