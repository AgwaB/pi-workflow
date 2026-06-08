Historical archive. Non-authoritative. Preserved for recovery context only.

# Workflow Engine Comparison: pi-workflow vs pi-dynamic-workflows (Kimi)

Date: 2026-06-08
Subagent model: `kimi-coding/kimi-for-coding` (thinking: medium)
Method: isolated /tmp build of the external package, identical review structure and target on both sides.

## TL;DR

- Same task, same model, equivalent stage structure (triage → reviewers fan-out → devil-advocate fan-out → synthesis).
- **Our `pi-workflow` (deep-review recipe): ~32 min, 14 tasks, 5 verified findings, valid structured JSON, full per-task token telemetry, live inspectable progress.**
- **External `pi-dynamic-workflows` with JSON-Schema structured output: failed in practice (~9 min wasted).** Kimi could not satisfy the forced `structured_output` termination, so triage returned null and the whole fan-out collapsed to 0 findings.
- **External `pi-dynamic-workflows` without schema (free-text + manual JSON parse): ~23.5 min, 15 agents, 7 findings, good quality** — but zero live observability and no durable artifacts.
- Quality was comparable when the external one actually ran: both engines independently found the same top bugs (watchRun timer leak, swallowed writeRunRecord, non-atomic foreach dual write).

## Setup

- External repo cloned + built in `/tmp/pdw-compare/pi-dynamic-workflows` (v1.0.1, commit `31b2aca`).
- Kimi forced on the external side via `new WorkflowAgent({ session: { model: getModel('kimi-coding','kimi-for-coding'), thinkingLevel: 'medium', tools: ['read','grep','find','ls'] } })`.
- Our side: `deep-review` recipe copied to `/tmp/pdw-compare/deep-review-kimi.json` with `defaults.model = kimi-coding/kimi-for-coding`, run via `runWorkflowSpec` + `waitForRun` against the compiled `.tmp/unit` build.
- Target (identical both sides): review `src/engine.ts` of this project for correctness, concurrency, and safety, with file:line evidence.
- The two `workflow` tools were never loaded together (they both register a `workflow` tool and would collide).

## Results

### Speed (wall-clock)

| Run | Wall-clock | Notes |
|---|---|---|
| Ours: deep-review (kimi) | ~1917 s (~32 min) | 14 tasks, full fan-out + reduce |
| External: schema-forced | ~550 s (~9 min) | effectively failed (0 findings) |
| External: no-schema (text) | ~1413 s (~23.5 min) | 15 agents, completed |

Notes:
- Our wall-clock is end-to-end including a slow tail devil-advocate task and the final reduce.
- External no-schema is faster in raw minutes but does less bookkeeping (no persisted artifacts, no per-task records, no supervisor lease/heartbeat, no JSON-output validation/retry).
- These are single samples on a subscription model with variable latency; treat ±20% as noise.

### Cost (tokens)

| Run | Token accounting |
|---|---|
| Ours | Exact per-task usage captured in each `result.json`: input 13,446 / output 30,636 / cacheRead 334,592 / **total 378,674**; cost = 0 (subscription) |
| External | No real token accounting. Only an internal heuristic `estimateTokens = JSON.stringify(result).length / 4`. Not comparable. |

This is itself a finding: our engine records real provider usage per task; the external engine has no usage telemetry at all.

### Quality

Both engines, when they ran, produced evidence-backed reviews of `src/engine.ts` and **converged on the same top defects**.

Ours (5 findings, devil-advocate verified, verdict NEEDS_FIX):
1. high — `watchRun` interval leaks on `refreshRun`/`scheduleRun` throw → infinite supervisor error loop (engine.ts:97-111)
2. high — `launchPendingTaskAt` swallows `writeRunRecord` failures after terminal transitions → stale pending → relaunch storm (engine.ts:530-539)
3. low (weakened) — `runWorkflowSpec` ignores `withRunLease` return value (engine.ts:46-51)
4. low (weakened) — `watchRun` setInterval self-overlap (bounded by lease)
5. low (weakened) — `materializeForeachTask` mutates caller's compiledFlow in place

External no-schema (7 findings, verdict kept 2 / weakened 5 / dropped 1):
1. high — non-atomic dual write in `materializeForeachTask` → persistent index misalignment (engine.ts:322-333)
2. medium — orphaned supervisor timer on async rejection in `watchRun` (engine.ts:93-114)
3. medium — `scheduleDag` pairs `run.tasks[index]` with `compiledFlow.tasks[index]` positionally (engine.ts:267-268)
4-7. low — `recordSupervisorError` swallows its own failures; post-failure `writeRunRecord` swallowed (×2); no process-exit timer cleanup

Assessment:
- Overlap is high: both found the watchRun timer leak and the swallowed post-failure `writeRunRecord`.
- The external no-schema run actually surfaced a couple of extra real angles (positional index pairing in scheduleDag, process-exit cleanup) — credit where due.
- Our run added explicit devil-advocate verdicts and a clean machine-readable contract.
- Net: comparable substantive quality on this task. The decisive differences are reliability and observability, not raw reviewer insight.

## Key qualitative differences observed during the runs

1. Structured output contract
   - External forces `structured_output` with `terminate: true`. With Kimi this failed hard: "Subagent finished without calling structured_output", and the engine just returned null and kept going, producing an empty review. No retry.
   - Ours uses a JSON output contract with one corrective retry and tolerant extraction (fenced/loose JSON). Same Kimi model produced valid JSON and the run completed.

2. Observability
   - Ours: every task is a durable record under `.pi/workflows/<run-id>/` (status, statusDetail, model, result.json with usage, output.log). We could watch progress live the entire time (triage → 5 reviewers → 8 devil-advocate → report).
   - External: in-memory only. For 9–23 minutes there was no visible progress; the only signal was an open HTTPS socket. Failure (schema run) was only discoverable at the very end.

3. Durability / resumability
   - Ours persists run + tasks + artifacts; supervisor lease + watch survive and reconcile.
   - External keeps nothing on disk; a crash loses the entire run.

4. Failure semantics
   - External: failed branch → `null` + a log line, silently. The schema run shows how this can yield a confidently-empty result.
   - Ours: failed source handling is explicit (sourcePolicy), terminal states persisted, partial-review limitation is reported in the synthesis.

5. Token/cost telemetry
   - Ours: real per-task provider usage.
   - External: none (heuristic only).

## Caveats / fairness notes

- Single run per configuration; latency on a subscription model is noisy.
- The external engine is explicitly a prototype (its README says no persistence/resume yet), so comparing durability is comparing stated scope, not a hidden gap.
- The schema-forced external failure is partly a Kimi+structured_output interaction, not purely an architecture flaw — but our engine handled the same Kimi behavior without failing, which is the point of the comparison.
- We forced an identical structure on the external side; left to free generation, the external model would produce a different (often simpler) graph each time.

## Conclusion

For the "deep review with Kimi" workload:

- If you want speed-on-a-good-day and minimal machinery, the external dynamic-JS engine can finish a comparable review in fewer minutes — when the model cooperates with its output contract.
- If you want reliability, observability, durable artifacts, real token telemetry, and graceful handling of imperfect model output (exactly what Kimi exhibited), `pi-workflow` is clearly stronger: it completed cleanly where the external schema path failed outright, and it produced equal-quality findings with full traceability.

The strongest borrow remains: keep our recipe-first durable runtime, and adopt the external project's compact live-progress display and its terminating structured-output pattern — but pair that pattern with our retry/tolerant-parse so it does not collapse on models like Kimi.

## Artifacts

- Ours run: `.pi/workflows/workflow_mq54zx7r_7ff5f2/` (report: `tasks/task-4/output.log`)
- External raw results: `/tmp/pdw-compare/RESULT-external-schema.json`, `/tmp/pdw-compare/RESULT-external-noschema.json`
- Ours report copy: `/tmp/pdw-compare/RESULT-ours-report.json`
- Runners: `/tmp/pdw-compare/run-ours.mjs`, `/tmp/pdw-compare/pi-dynamic-workflows/run-external*.mjs`
