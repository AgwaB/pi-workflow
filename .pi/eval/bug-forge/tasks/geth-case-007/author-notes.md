# geth-case-007 author notes

Source: ethereum/go-ethereum commit `bc1967f088469b7d78607b75bd7df3e960d0df82`.

Intent: snapshot generator goroutine survives Release shutdown.

OSS hard pilot. Source-only reverse of snapshot lifecycle fix; private repro keeps upstream goleak regression test.

Target repro command:

```bash
go test ./core/state/snapshot -run TestGenerateGoroutineLeak -count=1
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
