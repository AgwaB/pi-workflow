# geth-case-008 author notes

Source: ethereum/go-ethereum commit `8091994e7b5954827ad68ccca463647b220b1621`.

Intent: snap sync testPeer request counter data race.

OSS pilot. Test harness race; useful for concurrency recall but lower priority than production defects.

Target repro command:

```bash
go test -race ./eth/protocols/snap -run TestMultiSyncManyUseless -count=1
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
