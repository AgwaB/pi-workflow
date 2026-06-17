# geth-case-003 author notes

Source: ethereum/go-ethereum commit `c16684c1eec23bdc3f806827713aad380a6a90f3`.

Intent: eth_simulateV1 pre-Shanghai withdrawals fields.

OSS pilot. Source-only reverse of the upstream fix; private repro keeps the upstream regression test.

Target repro command:

```bash
go test ./internal/ethapi -run TestSimulateV1WithdrawalsByFork -count=1
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
