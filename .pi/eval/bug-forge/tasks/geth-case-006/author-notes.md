# geth-case-006 author notes

Source: ethereum/go-ethereum commit `22919cec1b257b3f2d3a2c348f432c08efae7114`.

Intent: native tracer Stop/GetResult interruption reason data race.

OSS hard pilot. Source-only reverse of production tracer fix; private repro keeps upstream race regression test.

Target repro command:

```bash
go test -race ./eth/tracers/native -run TestTracerStopRace -count=1
```

Leakage note: candidates must only see the sanitized workspace, neutral prompt, and fixture.diff. Do not expose this file, upstream PR/issue metadata, gold key, reference fix, or repro script during live review.
