Historical archive. Non-authoritative. Preserved for recovery context only.

# Dynamic Workflow Research: Claude Code, pi-dynamic-workflows, and pi-workflow

Date: 2026-06-07  
Local project intended: `/Users/toby/pi/pi-subagent-flow`  
External repo: <https://github.com/Michaelliv/pi-dynamic-workflows>

> Note: while writing this report, the local project path `/Users/toby/pi/pi-subagent-flow` was unavailable to the tool runtime (`ENOENT`). This file is therefore written to `/tmp/pi-dynamic-workflows-deep-research.md`. Move it into the repo later, recommended path: `docs/dynamic-workflows-research.md`.

## 1. Executive summary

`Michaelliv/pi-dynamic-workflows` is a Pi extension that intentionally recreates Claude Code-style dynamic workflows for Pi. It is much closer to Claude Code's dynamic JS workflow runtime than to our current `pi-workflow` recipe-first runtime.

The external project provides:

- a Pi `workflow` tool;
- model-authored JavaScript workflow scripts;
- `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, `budget` globals;
- Node `vm` sandbox execution;
- AST validation via `acorn` for deterministic metadata and blocked nondeterministic APIs;
- in-memory Pi subagents;
- structured output through a terminating `structured_output` tool;
- compact live progress rendering.

It does **not** provide:

- persisted workflow runs;
- resumable runs;
- a `/workflows` manager;
- recipe validation/modeling comparable to our stage-first JSON/YAML recipes;
- tmux-backed durable child processes;
- worktree policy, continuation lineage, budget guard artifacts, or `.pi/workflows` run store.

Conclusion:

- If the goal is to support Claude-style dynamic JS workflows in Pi, this repo already implements a credible prototype.
- If the goal is our current `pi-workflow` direction — deterministic, recipe-defined, persisted, inspectable workflows — this repo should **not** replace our architecture.
- It is most useful as a reference implementation for **sandbox parsing**, **progress rendering**, **structured-output termination**, and **pipeline semantics**.
- It also creates a likely **tool name conflict**: it registers a `workflow` tool, as does our `pi-workflow` extension.

## 2. Prior Claude Code dynamic workflow observations

We previously observed Claude Code's native dynamic workflow behavior by running several small workflow probes locally.

### 2.1 Generated JS DSL

Claude Code generated workflow scripts shaped like:

```js
export const meta = { name, description, phases }
phase('Read')
const [a, b] = await parallel([
  () => agent('...', { label: 'docs-reader', phase: 'Read' }),
  () => agent('...', { label: 'src-reader', phase: 'Read' }),
])
phase('Synthesize')
return await agent(`Use ${a} and ${b}`, { label: 'synthesizer' })
```

Observed globals:

- `meta`
- `phase(title)`
- `log(message)`
- `agent(prompt, opts)`
- `parallel(thunks)`
- `pipeline(items, ...stages)`
- ordinary JS arrays/promises/try-catch/setTimeout

Blocked/limited APIs:

- `Date.now()` / `new Date()` blocked;
- `Math.random()` blocked;
- `performance` not defined;
- `setTimeout` allowed.

### 2.2 `parallel` semantics

`parallel()` executes thunks concurrently and returns results in input order, not completion order.

Probe:

```js
const result = await parallel([
  () => sleep(80).then(() => 'slow'),
  () => sleep(10).then(() => 'fast'),
])
```

Observed result:

```js
['slow', 'fast']
```

### 2.3 `pipeline` semantics

Claude Code `pipeline()` is item-streaming, not stage-barrier.

Observed event order:

```text
fast_afterStage1
fast_afterStage2
slow_afterStage1
slow_afterStage2
```

This means each item advances to the next stage as soon as its previous stage completes. The entire previous stage does not need to finish first.

### 2.4 Structured output

`agent(prompt, { schema })` makes the subagent call a `StructuredOutput` tool. The returned workflow value is an object rather than raw text.

Invalid JSON Schema is rejected before spending child-agent tokens.

### 2.5 Resume/cache behavior

Claude Code's `Workflow({ scriptPath, resumeFromRunId })` can reuse completed agent results **within the same session/transcript directory**.

Observed same-session resume:

- same run id;
- `totalTokens: 0`;
- `totalToolCalls: 0`;
- progress entry included `cached: true`.

Cross-session resume reused the run id but re-executed child agents in a new transcript directory. So cache is effectively session/transcript-local.

## 3. External repo overview: `pi-dynamic-workflows`

### 3.1 Package metadata

From `package.json`:

- package: `pi-dynamic-workflows`
- version: `1.0.1`
- description: `Claude-Code-style dynamic workflow orchestration for Pi.`
- Pi extension: `extensions/workflow.ts`
- main: `dist/index.js`
- exports:
  - `.` -> library API
  - `./workflow` -> ambient workflow globals types
- dependencies:
  - `acorn`
- peer deps:
  - `@earendil-works/pi-ai ^0.78.0`
  - `@earendil-works/pi-coding-agent ^0.78.0`
  - `@earendil-works/pi-tui ^0.78.0`
  - `typebox`

### 3.2 README claims

The README explicitly frames the package as:

> Claude-Code-style dynamic workflows for Pi.

It installs via:

```bash
pi install npm:pi-dynamic-workflows
```

and registers a `workflow` tool, activated on session start.

Workflow script shape:

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect a repository and summarize the main modules',
  phases: [{ title: 'Scan' }, { title: 'Analyze' }],
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory',
})

phase('Analyze')
const summary = await agent('Summarize: ' + inventory, {
  label: 'module summary',
})

return { inventory, summary }
```

README status says this is a prototype and does not yet implement persisted/resumable runs or a `/workflows` manager.

## 4. External repo architecture

### 4.1 `src/workflow.ts` — parser and runtime

Responsibilities:

- parse workflow JS with `acorn`;
- require first statement to be `export const meta = ...`;
- validate `meta` as literal-only metadata;
- reject nondeterministic APIs in the full AST;
- run workflow body inside Node `vm` context;
- expose workflow globals;
- implement `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`;
- enforce concurrency limit;
- return `WorkflowRunResult` with meta/result/logs/phases/agentCount/durationMs.

Important details:

- `parseWorkflowScript` removes the `export const meta` declaration from the script body before VM execution.
- `assertDeterministicAst` recursively rejects:
  - `Date.now()` including computed/static string forms;
  - `Math.random()` including computed/static string forms;
  - `new Date()`.
- Literal `meta` accepts:
  - object expressions;
  - arrays;
  - literals;
  - static template literals;
  - negative numeric unary expressions.
- Literal `meta` rejects:
  - spreads;
  - computed keys;
  - accessors/methods;
  - reserved keys `__proto__`, `constructor`, `prototype`;
  - sparse arrays;
  - template interpolation;
  - non-literal identifiers/calls.

Runtime globals include:

```ts
agent, parallel, pipeline, log, phase, args, cwd,
process: { cwd: () => cwd }, budget,
console, JSON, Math, Array, Object, String, Number, Boolean, Set, Map, Promise
```

Notable omissions:

- `Date` is not included in the VM context, so even allowed `Date.parse` from parser tests likely would fail at runtime if actually executed unless inherited differently by Node VM. Parser tests only check parse acceptance, not runtime availability.
- no `setTimeout` is explicitly injected in this implementation, unlike Claude Code's observed native runtime. Node `vm` contexts do not automatically include all browser/node globals unless supplied. This may mean README/ambient behavior differs from Claude Code for sleep-style probes.

`parallel(thunks)`:

- requires an array of functions;
- wraps each thunk in try/catch;
- logs branch failure and returns `null` unless aborted;
- uses `Promise.all`, preserving input order.

`pipeline(items, ...stages)`:

- validates first arg is array and all stages are functions;
- maps items concurrently with `Promise.all`;
- each item runs stages sequentially;
- returns `null` for failed item unless aborted;
- each stage receives `(prev, original, index)`.

Concurrency:

- `agent()` calls pass through `createLimiter`.
- Default concurrency is `max(1, navigator.hardwareConcurrency - 2)` capped to 16.
- `parallel` and `pipeline` can create many branches, but actual `agent()` calls are limited.

Failure model:

- `agent()` catches non-abort errors, logs them, returns `null`.
- `parallel()` catches branch errors, logs, returns `null`.
- `pipeline()` catches item/stage errors, logs, returns `null` for that item.
- Top-level JS errors still fail the whole workflow.

### 4.2 `src/workflow-tool.ts` — Pi tool wrapper

Responsibilities:

- define the Pi `workflow` tool;
- schema requires a raw JS `script` and optional `args`;
- normalize Markdown fenced scripts;
- parse workflow script before execution;
- create and update live progress snapshot;
- stream progress updates via tool updates;
- handle abort signal;
- reject workflows with zero `agent()` calls.

Important prompt guidelines:

- use only when user asks for workflow/fan-out/multi-agent orchestration;
- raw JS only, no fences;
- first statement must be literal `export const meta`;
- do not use TypeScript/import/require/fs/Date.now/Math.random/new Date;
- `parallel` takes thunks, not promises;
- `pipeline` item stages run concurrently across items;
- failed branches return null;
- include a final synthesis/assertion agent;
- use `schema` for machine-readable output.

Important mismatch:

- `runWorkflow()` itself allows zero-agent JS; `createWorkflowTool()` rejects it after the run with `workflow scripts must call agent() at least once`.
- In native Claude Code experiments, zero-agent workflow scripts were accepted. This external package deliberately disallows them at tool level.

### 4.3 `src/agent.ts` — in-memory subagent runner

Responsibilities:

- create fresh in-memory Pi subagent session per `agent()` call;
- use standard coding tools via `createCodingTools(cwd)`;
- optionally append extra tools;
- add a terminating structured output tool when schema is provided;
- pass task label, instructions, and output contract into prompt;
- return last assistant text or captured structured output;
- support abort via `session.abort()`;
- dispose session after run.

Important details:

- subagents run in-memory, not tmux;
- no persisted transcript/run store in this package;
- subagents use normal coding tools and can read/run shell commands like a normal Pi turn;
- structured output requires exactly that the tool be called at least once, otherwise error.

### 4.4 `src/structured-output.ts`

Defines `createStructuredOutputTool`:

- uses Pi `defineTool`;
- parameters are the provided TypeBox/JSON Schema;
- captures params into a mutable `capture` object;
- returns `terminate: true`, avoiding an extra assistant final turn.

This is a clean and useful pattern.

### 4.5 `src/display.ts`

Defines:

- `WorkflowSnapshot`
- `WorkflowAgentSnapshot`
- compact renderers for workflow progress
- widget/tool update display adapters

UI design:

```text
◆ Workflow: inspect_project (3/3 done)
  ✓ Scan 1/1
    #1 ✓ repo inventory
  ✓ Analyze 2/2
    #2 ✓ source modules
    #3 ✓ final summary
```

Notable behavior from tests:

- declared `meta.phases` are not pre-rendered as empty rows;
- runtime-created phases are shown;
- current empty phase is shown;
- empty skipped conditional phases are hidden;
- logs are rendered separately and limited.

### 4.6 `extensions/workflow.ts`

Registers the `workflow` tool and activates it on `session_start` if not already active.

This means installing this extension changes the available tool surface for every session where extension is loaded.

## 5. Tests and actual guarantee surface

Test files cover:

- parser accepts literal metadata;
- parser rejects non-literal/hazardous metadata;
- parser rejects nondeterministic APIs;
- parser allows nondeterministic names inside strings/prompts/comments;
- runtime records dynamic phases;
- runtime hides skipped conditional phases;
- runtime rejects unawaited `agent()` promises via structured clone check;
- runtime rejects non-string phase titles;
- display hides empty phase rows and respects log limits;
- workflow tool docs/guidelines mention optional dynamic phases.

Not deeply covered in fetched tests:

- actual VM sandbox escape attempts;
- no-import/no-require runtime tests;
- structured output validation failure/retry semantics;
- abort behavior under active subagents;
- concurrency limiter edge cases;
- budget exhaustion behavior;
- tool collision behavior when another extension also registers `workflow`.

## 6. Comparison: external `pi-dynamic-workflows` vs our `pi-workflow`

### 6.1 Shared goals

Both projects aim to let Pi orchestrate multiple subagents for decomposable work.

Shared concepts:

- workflow abstraction;
- subagent fan-out/fan-in;
- phases/progress;
- structured output;
- parallel execution;
- user asks naturally for workflow-like work.

### 6.2 Core difference

`pi-dynamic-workflows`:

```text
model writes JavaScript script
→ workflow tool runs script in VM
→ script calls in-memory subagents
→ live snapshot returned to parent
```

Our `pi-workflow`:

```text
explicit JSON/YAML recipe
→ schema/compiler validate stage-first graph
→ runtime schedules persisted tasks
→ tmux/local Pi backend executes children
→ artifacts under .pi/workflows
→ board/inspect/wait/show manage run lifecycle
```

### 6.3 Persistence and resumability

External repo:

- no persisted run store;
- no resumable runs;
- no `/workflows` manager;
- in-memory sessions;
- final result only returned through tool details.

Our repo:

- `.pi/workflows/<run-id>/` persisted artifacts;
- `run.json`, `compiled.json`, `spec.json`, result/output/stderr files;
- supervisor leases and resume on session start;
- CLI inspect support;
- board/status/show/logs/wait commands.

### 6.4 Safety and validation

External repo:

- validates JS metadata and blocks some nondeterministic APIs;
- VM has no `require`, `import`, `fs`, network APIs in context;
- but script is still model-authored executable orchestration;
- subagents have normal coding tools;
- workflow tool activates automatically;
- no recipe-level tool ceiling/worktree policy comparable to our system.

Our repo:

- validates recipes before execution;
- agent tool ceiling and read-only/worktree policy are central constraints;
- backend is fixed and fail-closed;
- workflow graph is explicit and auditable;
- persisted artifacts allow post-hoc review.

### 6.5 Progress UX

External repo has a very compact and polished live progress model:

- workflow snapshot;
- phases from runtime `phase()` calls;
- agent rows with labels/status/resultPreview;
- no empty declared phases;
- log limits.

Our progress/board can borrow this directly at the display/model level without adopting JS execution.

### 6.6 Structured output

External repo's `structured_output` tool with `terminate: true` is a strong pattern.

Our current recipe output contracts are more file/result-artifact oriented. We can borrow the idea of a terminating structured output channel for child tasks if Pi child execution mode supports it cleanly. Even if not, the validation and output retry pieces can use the same conceptual model.

### 6.7 Pipeline semantics

External repo matches Claude Code native behavior:

- `pipeline(items, ...stages)` is item-streaming;
- each item moves through stages independently;
- different items run concurrently.

Our stage-first model is currently barrier-based: later reduce stages consume prior stage contexts. Immediate streaming would require a new semantics RFC.

### 6.8 Tool naming conflict

External repo registers a Pi tool named `workflow`.

Our `pi-workflow` also registers a `workflow` tool.

If both are installed, likely issues:

- duplicate tool name registration;
- ambiguous model prompt guidance;
- user-facing confusion: dynamic JS `workflow` vs recipe `workflow`;
- possible extension load order conflicts.

This is strategically important. If the external package gains adoption, our package should clearly differentiate:

- either remain recipe-first `workflow` and document incompatibility;
- or rename one tool/surface;
- or detect conflict and fail with a clear message.

## 7. Is it “already the same as ours”?

Short answer: **it overlaps at the product label but not at the architecture layer.**

It is similar to our project in that:

- it is a Pi package;
- it registers a workflow tool;
- it orchestrates multiple subagents;
- it targets the same Claude Code dynamic workflow inspiration.

It differs fundamentally because:

- it executes model-authored JS;
- it is not recipe-first;
- it is not persisted/resumable;
- it has no deterministic `.pi/workflows` run store;
- it lacks our stage-first recipe model, continuation, budget/QA-ish workflow recipes, tmux backend, and inspect CLI.

So it is not a drop-in replacement. It is a lightweight dynamic-workflow prototype that may occupy a competing namespace.

## 8. What should we borrow?

### 8.1 Strong borrow: display/progress model

Borrow the concepts, not necessarily code:

- `WorkflowSnapshot`
- `WorkflowAgentSnapshot`
- phase grouping that hides empty phases;
- compact text rendering;
- bounded result previews;
- log limits.

Recommended integration:

- add a derived progress view in our formatter/board layer;
- do not store all progress as canonical state;
- derive from run/tasks/result artifacts.

### 8.2 Strong borrow: terminating structured output tool pattern

The external `structured-output.ts` is small and clean.

Potential adoption:

- use a terminating structured output tool in child Pi runs when recipe `output.format=json` is set;
- or keep file-based result extraction but adopt the “structured output is final answer channel” prompt/validation model.

Benefits:

- fewer extra assistant turns;
- cleaner JSON output;
- less fragile parsing from prose/fences.

Risks:

- must ensure child Pi execution mode/tool routing allows injecting a task-local structured output tool;
- must preserve recipe tool ceiling rules.

### 8.3 Medium borrow: AST parser design if we ever support dynamic workflows

If we ever add a separate experimental dynamic-workflow mode, this repo's parser is the right starting reference:

- `acorn` AST parse;
- literal-only metadata;
- deterministic API checks;
- VM context whitelisting.

But current recommendation remains: do **not** add JS DSL to our main `pi-workflow` package.

### 8.4 Medium borrow: `pipeline` semantics as RFC

Item-streaming can cut wall-clock time in large fan-out/fan-in workflows.

Do not implement immediately. Instead write an RFC for possible future:

```json
{
  "id": "verify-claims",
  "type": "foreach",
  "streaming": true,
  "each": { ... },
  "thenEach": { ... }
}
```

But this conflicts with current `reduce.from` and `sourcePolicy` semantics, so it needs a careful design.

### 8.5 Medium borrow: branch failure returns null/log

External dynamic workflows prefer partial progress: failed branches return `null` and log failure.

Our stage-first runtime already has `sourcePolicy: partial`. We can improve UX by making partial failures more visible in progress/reporting, not by changing default failure semantics.

## 9. What should we not borrow?

### 9.1 Do not borrow JS workflow execution as core

Reasons:

- increases user learning surface;
- undermines recipe validation;
- creates sandboxing burden;
- complicates persistence/resume;
- conflicts with our package's public direction.

### 9.2 Do not automatically activate broad workflow tool without conflict checks

External package activates the `workflow` tool on session start. Our package should be careful if both are installed.

Recommended action:

- add conflict detection or at least documentation;
- consider future tool naming if collision becomes real.

### 9.3 Do not rely on in-memory sessions for durable workflows

External repo's simplicity is partly because it avoids persistence. Our value proposition is durable local artifacts. Keep that boundary.

## 10. Strategic options

### Option A — Continue recipe-first and document difference

Recommended.

Positioning:

- `pi-dynamic-workflows`: ad-hoc Claude-style dynamic JS workflows.
- `pi-workflow`: deterministic, recipe-defined, persisted workflow runtime.

Actions:

- add comparison docs;
- improve progress UX;
- consider conflict detection.

### Option B — Add optional dynamic mode to our package

Not recommended now.

Would require:

- JS parser/runtime;
- sandbox policy;
- no-Date/no-random checks;
- persistence model for dynamic scripts;
- tool name/surface design;
- security review.

This risks scope creep.

### Option C — Integrate/federate with external package

Possible later.

For example:

- if `pi-dynamic-workflows` is installed, our docs can recommend it for ad-hoc dynamic workflows;
- our package remains recipe-first;
- avoid duplicate tool naming by convention or detection.

## 11. Recommended next actions

1. Add this report to repo docs when local path is restored:
   - suggested: `docs/dynamic-workflows-research.md`.
2. Add a shorter README note or docs page clarifying:
   - recipe-first `pi-workflow` vs dynamic JS workflows.
3. Implement progress/event improvements from prior plan:
   - derived progress view;
   - append-only event journal;
   - telemetry/result previews.
4. Evaluate structured output termination integration:
   - can child Pi task be given a task-local terminating tool without violating tool ceiling?
5. Add conflict detection/design note for another `workflow` tool.
6. Defer streaming pipeline to an RFC.

## 12. Source notes

Primary source: <https://github.com/Michaelliv/pi-dynamic-workflows>

Fetched files:

- `README.md`
- `package.json`
- `src/workflow.ts`
- `src/workflow-tool.ts`
- `src/agent.ts`
- `src/structured-output.ts`
- `src/display.ts`
- `extensions/workflow.ts`
- `types/workflow.d.ts`
- `tests/workflow-parser.test.ts`
- `tests/workflow-runtime.test.ts`
- `tests/workflow-tool.test.ts`
- `tests/workflow-display.test.ts`
- `src/index.ts`

Prior local observation notes:

- Claude Code native dynamic workflow probes conducted locally on 2026-06-07.
- Existing local note was intended at `.tmp/claude-workflow-deep-dive.md`, but the local repo path became unavailable during this turn.
