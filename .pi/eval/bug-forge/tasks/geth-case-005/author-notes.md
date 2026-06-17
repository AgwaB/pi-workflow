# geth-case-005 author notes

Source: ethereum/go-ethereum commit `f4a90d178a53ab8792dde74eec8db40c6120e111`.

Intent: RPC method length validation order.

OSS pilot. Source-only reverse of the upstream fix; private repro keeps the upstream websocket regression test.

Target repro command:

```bash
go test ./rpc -run TestWebsocketMethodNameLengthLimit -count=1
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
