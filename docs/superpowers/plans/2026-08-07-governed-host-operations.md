# Governed Host Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a trusted host provide explicitly declared, JSON-only dynamic-controller operations with durable replay and crash reconciliation.

**Architecture:** Workflow specs declare operation aliases mapped to host capability names. Dynamic-controller workers send only an alias and JSON request; the parent engine resolves the registered adapter, supplies frozen run and bundle provenance, and records started/completed events. Completed calls replay from the ledger, while an interrupted started call uses the adapter's reconciliation method with the same idempotency key.

**Tech Stack:** TypeScript, Node worker threads, JSONL dynamic events, Node test runner.

## Global Constraints

- Never serialize host adapter functions into worker data.
- Reject undeclared aliases, missing capabilities, and non-JSON requests or results before completion.
- Persist a stable request hash and idempotency key before invoking the adapter.
- Never invoke an adapter again after a matching completed event.
- A dangling started event may call only the adapter reconciliation method.
- Keep product-specific workflow, path, source-SHA, and result policy outside this package.

---

### Task 1: Schema and compiled contract

**Files:**
- Modify: `src/types.ts`
- Modify: `src/artifact-graph-schema.ts`
- Modify: `src/compiler.ts`
- Test: `test/unit/unit-dynamic-runtime.test.mjs`

**Interfaces:**
- Consumes: `dynamic.hostOperations` as `{ [alias]: { capability: string } }`.
- Produces: `CompiledDynamicWorkflowTask.hostOperations` with the same immutable alias-to-capability mapping.

- [ ] Add failing parser/compiler tests for a valid declaration, unknown fields, reserved aliases, and missing capability.
- [ ] Run the focused test and confirm the new cases fail because `hostOperations` is unsupported.
- [ ] Add the minimal types, validation, and compiler projection.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Durable parent-owned invocation

**Files:**
- Create: `src/dynamic-host-operations.ts`
- Modify: `src/dynamic-events.ts`
- Modify: `src/dynamic-state.ts`
- Modify: `src/engine.ts`
- Test: `test/unit/dynamic-host-operations.test.mjs`
- Modify: `test/unit/unit-test-support.mjs`

**Interfaces:**
- Consumes: `WorkflowHostCapabilities`, where each capability supplies `invoke(request, context)` and `reconcile(request, context)`.
- Produces: worker API `ctx.host.invoke(alias, request)` and dynamic events `host.started` / `host.completed`.

- [ ] Add failing tests proving declared invocation, frozen provenance, missing/undeclared rejection, JSON validation, and no adapter functions in worker data.
- [ ] Add failing replay tests proving completed calls are returned without reinvocation and dangling starts call reconciliation with the original idempotency key.
- [ ] Run the focused tests and confirm the expected missing-API failures.
- [ ] Implement the host operation runner, engine option threading, worker op, event persistence, and replay-prefix integration.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Public contract and verification

**Files:**
- Modify: `src/index.ts`
- Modify: `docs/usage.md`
- Test: `test/unit/wb-012-public-contracts.test.mjs`
- Test: `test/unit/dynamic-host-operations.test.mjs`

**Interfaces:**
- Consumes: the types and runtime behavior from Tasks 1 and 2.
- Produces: documented public host capability types and scheduling options.

- [ ] Add a failing public-surface assertion for the exported host capability types.
- [ ] Export and document the API, including the requirement to pass the registry again when resuming or waiting.
- [ ] Run focused tests, typecheck, and the package validation command.
- [ ] Commit, push `codex/governed-host-operations`, and open a PR against `calltelemetry/pi-workflow`.
