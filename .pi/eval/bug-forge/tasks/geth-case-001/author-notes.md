# geth-case-001 author notes

Source: ethereum/go-ethereum commit `281dc4c2091400ea1388b030300e5adc7672ffa0`.

Intent: p2p/discover waitForNodes lock/feed deadlock.

OSS pilot. Source-only reverse of the upstream fix; private repro keeps the upstream regression test. RED is timeout-like by design.

Target repro command:

```bash
go test ./p2p/discover -run TestTable_waitForNodesLocking -count=1 -timeout 20s
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
