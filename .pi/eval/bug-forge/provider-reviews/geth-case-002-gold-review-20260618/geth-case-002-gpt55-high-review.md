## Verdict: NEEDS_CHANGES

## Summary

Current G1 is valid, but the fixture introduces additional candidate-visible material bugs. The gold key should not remain a single-bug key for primary gating unless the fixture is narrowed. Recommended path: expand gold with separate G2/G3 entries and rescore into a separate `gold-reviewed-rescore.*` artifact; do not rewrite raw `score.json`.

## Gold bug review

G1 is valid.

The fixture moves journal lifecycle work from synchronous `Start`/locked `Stop` into `TxTracker.loop`:

- `core/txpool/locals/tx_tracker.go`:
  > `defer tracker.journal.close()`

This close now runs in the background goroutine without `tracker.mu`, while journal users such as `TrackAll` and `recheck` rely on `tracker.mu` around journal operations:

- `core/txpool/locals/tx_tracker.go`:
  > `_ = tracker.journal.insert(tx)`

- `core/txpool/locals/tx_tracker.go`:
  > `if err := tracker.journal.rotate(rejournal); err != nil {`

`journal` itself has no internal mutex, so moving load/setup/close into `loop` creates real unsynchronized access to `journal.writer`.

However, G1 should be broadened/refined: current required evidence only asks for `defer tracker.journal.close()`, but the race surface also includes async `journal.load` / `setupWriter` accessing `journal.writer`.

## Observed unmatched findings review

1. **`Start()` returns nil despite `setupWriter()` failure — true additional bug.**

   The fixture removes synchronous error propagation:

   - Removed from `Start`:
     > `return err`

   and adds async handling in `loop`:

   - `core/txpool/locals/tx_tracker.go`:
     > `if err := tracker.journal.setupWriter(); err != nil {`
     > `log.Error("Failed to setup the journal writer", "err", err)`
     > `return`

   But `Start` still returns nil immediately after spawning the goroutine:
   > `go tracker.loop()`
   > `return nil`

   `journal.setupWriter()` can fail:

   - `core/txpool/locals/journal.go`:
     > `sink, err := os.OpenFile(journal.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)`
     > `if err != nil { return err }`

   This is not an alternate phrasing of G1; it is a distinct startup error-propagation regression.

2. **`Stop()` no longer returns `journal.close()` errors — true additional bug, weaker but material.**

   The fixture changes `Stop` to:

   - `core/txpool/locals/tx_tracker.go`:
     > `return nil`

   while close errors are still possible:

   - `core/txpool/locals/journal.go`:
     > `err = journal.writer.Close()`
     > `return err`

   The deferred close in `loop` discards that error. This is distinct from the close race, though both share the moved-close root cause.

3. **Async `TrackAll`/insert before writer setup — real but should not be separate G4.**

   This is a consequence of moving journal initialization behind `go tracker.loop()`. `TrackAll` can run after `Start` returns but before `setupWriter` completes; `journal.insert` can then fail:

   - `core/txpool/locals/journal.go`:
     > `if journal.writer == nil { return errNoActiveJournal }`

   and the error is ignored:

   - `core/txpool/locals/tx_tracker.go`:
     > `_ = tracker.journal.insert(tx)`

   Treat this as part of G2 / async startup lifecycle regression, not a separate gold bug.

## Evidence/location recommendations

Update G1 evidence to include:

- `core/txpool/locals/tx_tracker.go`
  > `tracker.journal.load(func(transactions []*types.Transaction) []error {`
- `core/txpool/locals/tx_tracker.go`
  > `if err := tracker.journal.setupWriter(); err != nil {`
- `core/txpool/locals/tx_tracker.go`
  > `defer tracker.journal.close()`
- `core/txpool/locals/tx_tracker.go`
  > `_ = tracker.journal.insert(tx)`
- `core/txpool/locals/journal.go`
  > `journal.writer = sink`

Add G2:

- Summary: `Start returns success before journal setup completes and swallows setupWriter errors in loop`.
- Evidence quotes:
  > `go tracker.loop()`
  > `return nil`
  > `log.Error("Failed to setup the journal writer", "err", err)`
  > `return`
  > `os.OpenFile(journal.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)`

Add G3:

- Summary: `Stop no longer propagates journal close errors`.
- Evidence quotes:
  > `return nil`
  > `defer tracker.journal.close()`
  > `err = journal.writer.Close()`

## Scoring/rescore guidance

Preserve the listed raw compact scores and raw `score.json`.

If gold is expanded, write a separate `gold-reviewed-rescore.*` artifact. Expected qualitative changes:

- `plain` should get credit for G1 and G2; if G3 is added, it likely misses G3.
- `self-check` should get credit for G2.
- `workflow` should get credit for G2; count G3 only if the scorer accepts the embedded Stop-error claim as an explicit finding.

## Recommended changes

1. Do **not** approve current one-bug gold as primary-gate ready.
2. Expand gold to include G2 and G3, or narrow the fixture if a single-bug task is required.
3. Refine G1 to cover unsynchronized journal lifecycle access from `load/setup/close`, not only deferred close.
4. No obvious candidate-visible leakage risk found in source tests/comments. The lock-related comment in `recheck` is normal source context, not oracle leakage.
