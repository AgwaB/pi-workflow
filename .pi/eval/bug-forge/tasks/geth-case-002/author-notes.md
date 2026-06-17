# geth-case-002 author notes

Source: ethereum/go-ethereum commit `02dd66dfc0b1551bb55b95ae0b914a58441ce2ac`.

Intent: txpool locals journal lifecycle data race.

OSS pilot. Source-only reverse of the upstream fix; private repro uses Go race detector.

Target repro command:

```bash
go test -race ./core/txpool/locals -count=1
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
