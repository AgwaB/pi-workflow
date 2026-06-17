# geth-case-004 author notes

Source: ethereum/go-ethereum commit `dc07433d878edd49c376ed62a9f5749cc5ad31f9`.

Intent: getBlobs nil blob list JSON contract.

OSS pilot. Source-only reverse of the upstream fix; private repro keeps the upstream catalyst regression test.

Target repro command:

```bash
go test ./eth/catalyst -run TestGetBlobsV2And3 -count=1
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
