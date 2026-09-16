# pi-workflow Usage

Detailed usage reference for the public Pi command **`/workflow`** and the `pi-workflow` CLI.

## Install

```bash
pi install npm:@agwab/pi-workflow
```

Reload Pi after installation.

This installs:

- the `/workflow` extension
- the bundled `workflow-guide` skill
- the bundled `execution-router` skill
- bundled runtime helpers, including `@agwab/pi-subagent` and `pi-web-access`

### Runtime compatibility

| Component | Supported/tested boundary |
|---|---|
| Node.js | Requires `>=22.19.0`; CI runs the exact minimum `22.19.0` and current Node `24` on Linux and macOS. |
| Pi | The lockfile-tested SDK/extension baseline is `0.84.4`. The peer dependency is `*`: npm accepts other Pi versions, but this is not a claim that every version has been tested. |
| Pi `0.85.0` | Compatibility is blocked by its upstream package's missing `@earendil-works/pi-server` dependency. A version-print command alone does not establish working SDK, RPC, or extension loading. |

For checkout validation, use `npm ci --legacy-peer-deps`, then `npm run validate` and `npm run e2e`. Validation checks dependency declarations against the lock and installed package versions against locked versions, including nested dependencies; absent platform-optional packages are allowed. This read-only drift check neither updates dependencies nor verifies package-content integrity. Do not patch installed Pi files to claim compatibility.

For local development, install the checkout as a package source:

```bash
pi install /absolute/path/to/pi-workflow
```

You can also test for a single run with Pi's package/extension loading options, but a normal `pi install` mirrors the intended release path.

For Node consumers, import from the package root after installing the npm package:

```js
import { listWorkflows, resolveWorkflowRef } from "@agwab/pi-workflow";
```

Do not import private `src/`, `dist/`, or bundled workflow helper paths directly; those paths are package internals except for the documented `./extension` Pi entrypoint.

## Command surface

Pi command:

```text
/workflow
```

Terminal CLI:

```bash
pi-workflow inspect <run-id-or-prefix> [--failures] [--results] [--json]
pi-workflow prune [--keep N] [--older-than DAYS] [--yes] [--json]
pi-workflow notices list [--json]
pi-workflow notices acknowledge <exact-run-id> --state <sha256> --reason <text>
pi-workflow notices clear <exact-run-id> [--json]
pi-workflow supervise <run-id-or-prefix> [--poll-ms N] [--max-runtime-ms N]
pi-workflow supervise --all [--poll-ms N] [--max-runtime-ms N]
```

`/workflow` with no arguments opens the read-only workflow board TUI. `/workflow <run-id>` opens the board focused on that run.

## Natural-language invocation

The extension also registers LLM-callable tools for normal chat requests:

| Tool | Purpose |
|---|---|
| `workflow_list` | List discoverable workflows when the user asks what exists or asks Pi to choose without naming one. |
| `workflow_run` | Start a run when the user explicitly asks to use/run/start a named workflow and provides a concrete task. Set `awaitTerminal: true` when the current turn needs the final result. |
| `workflow_dynamic` | Start a spec-less direct dynamic run when the user explicitly asks for dynamic workflow execution and provides a concrete task. Optional `model` and `thinking` (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`) values override the controller defaults. Set `awaitTerminal: true` when synthesis must return in the current turn. |
| `workflow_wait` | Wait for an existing run id or unambiguous prefix to reach terminal state without model-driven file polling, then return semantic status and a bounded final-result preview. |

Examples:

```text
Use the deep-research workflow to research this repository's architecture tradeoffs.
```

```text
Use the deep-review workflow to review the current diff for reliability and test coverage.
```

`workflow_list` accepts `offset` (a non-negative safe integer, default `0`), `limit` (1–20, default `20`), and an optional case-insensitive name/alias `query`. Metadata is clipped for display, but `details.workflows[].specPath` retains the full usable path. Text, serialized content, and serialized details each have a 50 KiB/2,000-line budget, so a page can end before `limit`. Follow `details.nextOffset` with the same query; `details.total` counts all matches and `details.omitted` counts matches after this page. A single path that cannot fit fails explicitly rather than being truncated into an unusable locator.

Natural-language named-workflow invocation uses the same workflow resolution roots and task-required rule as `/workflow run`. If the workflow name or concrete task is missing, Pi should ask a clarifying question instead of launching a run. `workflow_run` and `workflow_dynamic` remain launch-only by default for compatibility. Use `awaitTerminal: true` plus an optional `timeoutMs`, or call `workflow_wait` with the returned run id. `awaitTerminal` binds the run to the current Pi session even when support-only work finishes immediately, and `workflow_wait` accepts only runs bound to that session so another session cannot consume its completion. Binding is retried for a bounded interval; if it still fails after launch, the error includes the run id and the deterministic recovery command `/workflow wait <run-id>`. Use that command for an older or differently owned run as well. Terminal presentation is deduplicated per stable terminal epoch, so resuming into the same terminal status produces a new completion while legacy status-only markers migrate to the current epoch. Tool wait timeouts accept 1,000–14,400,000 ms and default to 30 minutes; reaching the timeout does not stop the run. `detach: true` and `awaitTerminal: true` are mutually exclusive. Cancelling or timing out `workflow_wait` cancels only the wait, not scheduler-owned workflow progress. If a run becomes blocked rather than terminal, the tool returns `terminal: false`, `actionRequired: true`, blocked task ids, and inspect/resume guidance; it never labels an intermediate artifact as the final result. An explicit manual named launch is:

```text
/workflow run deep-research "Research this repository's architecture tradeoffs."
```

For explicit dynamic workflow requests that should not require a workflow name or spec, Pi can use `workflow_dynamic`. The deterministic manual equivalent is:

```text
/workflow dynamic "Research this repository's architecture tradeoffs."
```

`/workflow dynamic` uses pi-workflow's built-in trusted dynamic controller and
records a normal workflow run under `.pi/workflows/`. Use it when you explicitly
want adaptive orchestration rather than a named reusable workflow. The
LLM-callable `workflow_dynamic` tool uses the same controller. Neither form asks
the user to choose, generate, preview, approve, or save a workflow spec. Direct
dynamic generated workers validate external URL refs before completion,
verifier outputs are
asked to record structured `claimSupports`, and final synthesis additionally
requires at least one ref plus an upstream source-ledger subset check. Stale,
unreachable, or newly invented final URL refs trigger the normal
workflow-output retry path. When positive verifier `claimSupports` are present,
final URL refs are restricted to those supported source locators rather than
every upstream URL.

Refs URL availability validation applies its timeout separately to each DNS preflight and separately to each HTTP request. HEAD, fallback GET, and each redirect may each consume those bounds; this is not a whole-URL or whole-batch deadline. A late DNS result cannot dispatch HTTP after that preflight has timed out. Availability checks are not remote-content attestations.

### Auto comparison and confirmed execution

`/workflow auto "<task>"` is the opt-in recommendation surface. It compares only workflows: the trusted direct-dynamic runtime and a bounded catalog of discoverable named workflows. The catalog uses the same project-shared, project-private, user/global, and package roots as workflow discovery, parses only bounded `spec.json` metadata, and reports invalid, oversized, or omitted entries as partial rather than treating them as unfit. It never imports workflow helpers or controllers during comparison.

Workflow authors may add the optional `routing` object to a spec with bounded `useWhen`, `avoidWhen`, and `outputs` strings. The bounded authored description, routing hints, declared output/schema/verification markers, overhead proxies, basic declared stage/agent/tool facts, and the task are comparison data only; arbitrary workflow prompt text, local paths, and private source bytes are not classifier input. Descriptions are treated as untrusted data, never as instructions or a launch authority. At most one tool-less classifier comparison is made.

Classifier transmission requires a structured host/user decision before the task is sent. The interactive TUI asks whether it may send the task and bounded workflow metadata for that one comparison; denying or cancelling makes zero classifier calls. The exported `recommendWorkflowAuto` API requires an explicit `transmissionPolicy`; only `"allowed"` permits classifier dispatch, while an omitted, unrecognized, `"blocked"`, or `"needs-clarification"` value fails closed. Existing recognized English privacy/network restrictions can only tighten an explicit authorization. They are defense-in-depth checks, not a claim that task-text matching understands every language. Fixed input bounds also fail closed.

After interactive transmission authorization, a valid recommendation is followed by a workflow-only candidate picker and then a separate final launch confirmation. Cancelling any stage starts nothing; there is no hidden fallback. There is no current-conversation/editor-draft choice. If workflow execution is disallowed, only Cancel is offered. A named or direct-dynamic launch is recorded as an `auto-confirmed` v2 launch with opaque task/candidate facts. Named selections bind the selected spec, bundle resources, agents, and project identity; direct-dynamic selections bind the versioned runtime bundle and project identity. Both recheck their accepted source set before compilation and frozen bundle bytes before dispatch; a changed selection fails closed and must be compared again.

In print, RPC, and other headless slash-command contexts, `/workflow auto` cannot ask for transmission authorization, so it makes no classifier call and prints local catalog/recommendation-unavailable output. It uses `"<original task>"` rather than echoing task text in safe follow-up commands, cannot select a candidate, and cannot launch. A non-interactive API host must pass its own explicit structured policy. `/workflow run` always runs the named spec and `/workflow dynamic` always runs direct dynamic; neither uses the auto classifier, and both reject the retired `--route` and `--no-route` flags.

The `execution-router` skill remains advisory and recommendation-only. It may recommend a manual `/workflow run`, `/workflow dynamic`, `/workflow auto`, targeted verifier, or direct work, but it never executes or silently redirects a request.

### Migrating from legacy automatic routing

For scripts or habits based on the v0.9.0–v0.13.8 routing behavior:

- Remove `--route` and `--no-route`; current explicit `run` and `dynamic` commands reject both flags. Use `run <name>` when the named workflow is authoritative, or `dynamic` when direct dynamic execution is authoritative.
- To compare workflows instead, use interactive `/workflow auto "<task>"`. It asks for transmission authorization, a workflow choice, and final launch confirmation. It never offers a current-conversation/direct-chat candidate. For direct work, stay outside `/workflow`.
- Do not assume headless `/workflow auto` sends a classifier request. It shows local information only; an API host calling `recommendWorkflowAuto` must supply its own explicit structured transmission policy.
- Keep existing saved profiles. Compatible pre-routing/full-definition files remain readable without migration or deletion; execution-relevant definition changes still require a fresh explicit profile save.

These are source-checkout migration instructions, not an announcement that a new package version has shipped. Package identity, supported-platform CI, and release approval must be established separately before publishing changed CLI behavior.

### Dynamic child transcript budget telemetry

Dynamic-generated children receive a cumulative tool-result transcript cap of
`320_000` characters by default. This cap is separate from dynamic-controller
orchestration budgets such as `maxAgents`, `maxConcurrency`, and
`maxRuntimeMs`; it is also separate from the direct-dynamic `dynamicAudit`
claim/source accounting record. Character counts are not token counts.

Set `PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS` to a positive integer to
override the child transcript cap. Set it to `0`, a negative value, or a
non-number to disable the cap. Static tasks do not receive this dynamic-child
default.

Each launched dynamic child records the effective configuration and, when the
backend reports it, per-attempt retained characters, eviction counters,
warnings, and context-recovery flags under the task's optional
`toolResultBudget` field in `run.json`. Retry attempts remain separate. Missing
metadata from an old or interrupted backend is recorded as unavailable rather
than as zero pressure. Existing run files without this optional field remain
valid.

## Bundled skills

| Skill | Use when |
|---|---|
| `execution-router` | Advisory-only recommendation for direct work, an existing workflow, a targeted verifier/subagent, or a new/extended workflow; it never launches or redirects a run. |
| `workflow-guide` | Create, modify, review, validate, or explain workflow definitions after the authoring target is known. |

For reusable workflow authoring, `workflow-guide` includes validated scaffold bundles for common graph shapes. Copy and adapt a scaffold, or use its documented provider-free initializer for already-fixed inputs, then run `/workflow validate` on the resulting spec before use.

## Commands

| Command | Purpose |
|---|---|
| `/workflow` or `/workflow <run-id>` | Open the read-only workflow board TUI. With a run id or prefix, focus that run. Falls back to text `status` output in `--print` mode or when no TUI is available. |
| `/workflow help` | Show help. |
| `/workflow list` | List workflow specs discoverable from the current project and installed package. |
| `/workflow validate <workflow-name-or-path>` | Load and compile a workflow without starting a run. Reports blocked permission previews and warnings. A path may be a `.json` spec or a bundle directory containing `spec.json`. Non-interactive form for scripts and agents: `pi -p --no-session "/workflow validate <workflow-name-or-path>"` from the project directory. |
| `/workflow roles <workflow-name-or-path>` | Show each compiled role: source agent, included/excluded sections, truncation, and the exact `# Role Context` block injected into task prompts that select it. |
| `/workflow agents` | List discoverable Pi agents, model/thinking defaults, tool ceilings, and source paths. |
| `/workflow profile [workflow-name-or-path]` | Open the native Pi picker for the workflow's user-wide execution profile. Choose Codex, Codex High, Claude, Mixed, or Custom; preview every model-backed stage in a colored stage/role/model/thinking table; edit Custom model/thinking values; and save for the next run. Omitting the workflow opens a path-free workflow picker that shows each current saved profile. This command requires the interactive TUI and does not start a workflow or provider call. |
| `/workflow auto "<task>"` | Compare dynamic and bounded discoverable named workflows only. The interactive TUI first asks permission for one classifier transmission, then offers eligible workflows and a separate launch confirmation; cancelling permission sends nothing. No current-conversation option is offered. Print/RPC/headless slash use fails closed without a classifier call because it cannot prompt. No candidate starts until confirmation, and `"<original task>"` placeholders avoid task disclosure in generic follow-ups. |
| `/workflow run [--model MODEL] [--thinking LEVEL] [--profile NAME] <workflow-name-or-path> "<task>" [--detach] [--force-new]` | Start exactly the named workflow with the supplied runtime task; it does not classify or replace the requested workflow. `--route` and `--no-route` are rejected. `--profile NAME` applies a named `executionProfiles` entry declared by the spec (per-stage model, thinking, or batch overrides, recorded on the run record as `executionProfile`; unknown names fail closed). Launch precedence is explicit `--profile`, then a saved `/workflow profile` selection, then the prior omitted behavior: an interactive declared-profile selector, or `defaultExecutionProfile`/Base without a selector. Explicit `--profile` bypasses both saved and interactive selection. Declared profile names such as `low`, `medium`, and `high` are spec conventions, not the built-in user-profile names. `--detach` spawns a standalone supervisor process after the initial scheduling pass so the run keeps progressing after this Pi session exits (log: `.pi/workflows/<run-id>/supervise.log`). Dynamic controllers and `approval: "ask"` prompts in that first pass can still run inline; later detached/headless approval blocks require an interactive `/workflow resume <run-id>`. An identical active launch within 10 minutes is skipped unless `--force-new` is present. |
| `/workflow dynamic [--model MODEL] [--thinking LEVEL] "<task>" [--detach] [--force-new]` | Start exactly the spec-less direct dynamic run. The runtime uses a built-in trusted controller to plan/fan out/synthesize dynamically; no workflow name, user-selected spec, or generated spec is required. `--route` and `--no-route` are rejected; model, thinking, detach, duplicate-guard, and force-new controls otherwise match `/workflow run`. |
| `/workflow status [run-id]` | Show all workflow runs in the current project, or one run. |
| `/workflow show [--raw] <run-id-or-workflow-name>` | If the ref starts with `workflow_`, show formatted run details; otherwise show the workflow spec. `/workflow show --raw <run-id>` shows raw run details. |
| `/workflow logs <run-id> [task-id-or-spec-id] [lines]` | Print captured logs for a workflow task. Defaults to `task-1`; a stage/spec id resolves when it identifies a task unambiguously. |
| `/workflow wait <run-id> [timeout-ms]` | Poll until the run finishes or the optional timeout elapses. |
| `/workflow stop <run-id>` | Interrupt a non-terminal run, best-effort interrupt active subagents, mark unfinished tasks interrupted, and stop the local supervisor watch. Use `/workflow resume <run-id>` if you want to restart unfinished work later. |
| `/workflow prune [--keep N] [--older-than DAYS] [--yes] [--json]` | Preview or delete terminal runs beyond the retention filters. Deletion requires `--yes`. |
| `/workflow resume <run-id>` | Resume a failed, interrupted, or resumable blocked run (including dynamic approval blocked in headless mode): completed tasks are preserved; failed/interrupted/skipped or resumable blocked tasks reset to pending and reschedule. Loop workflows are not supported yet. |

Interactive `/workflow run` and `/workflow dynamic` slash commands use Pi's cancellable foreground loader while validating and completing the initial scheduling pass. After its separate transmission-authorization prompt, `/workflow auto` uses the same loader while it compares candidates, but only launches after its picker and final confirmation. After at least one backend task is actually running, the command returns and a compact `Active workflows` widget below the editor plus a footer status tracks top-level run progress. Launch/preparation states and stale `running` records with no running task are excluded. The widget is rebuilt from `.pi/workflows` after session reload, supports multiple active runs, and clears when none remain; open `/workflow` for the full board. Natural-language launch-only calls use the same background widget. Natural-language calls with `awaitTerminal: true`, and explicit `workflow_wait` calls, drive the existing scheduler until terminal or action-required blocked state and return the authoritative completion summary when available, otherwise a bounded fallback preview. They report retries, usage, degradation, and the artifact root. For an ordinary output-bearing `completed` run, active-session completion feedback passes the renderer's substantive result through without asking the parent to rewrite it: direct conclusion, any requested comparison snapshot, key findings or recommendations, evidence qualifications, and important limitations or open decisions remain intact. Routine success metadata stays out of the prose. When the final control declares readable task-local sidecars, the completion ends with safe project-relative `Final report` and, when available, `Evidence audit` paths; traversal, absolute, control-character, raw-protocol, missing, and symlink-escape candidates are omitted. Clean `workflow_run`/`workflow_wait` terminal tool text follows the same rule while keeping run ids, lifecycle state, retries, artifact roots, and the resolved report-artifact list in structured tool details for programmatic consumers. A final control field named `completionSummaryMarkdown`, when present, is preferred over the full report and handed off intact; only legacy/fallback full-report previews use the bounded preview truncation. Degraded, failed, blocked, interrupted, duplicate-delivery, and output-missing outcomes still surface lifecycle state and the next useful action. `engineStatus` is the persisted lifecycle state; `semanticStatus` interprets the result. Output-bearing successes include `completed`, `completed_degraded`, `synthesized`, and `exhausted_with_output`; `completed_without_semantic_result` and `exhausted_without_output` explicitly report that no authoritative result exists. Blocked variants return `actionRequired: true`, while `failed`, `interrupted`, and `dynamic_incomplete` are unsuccessful terminal outcomes. New direct-dynamic runtime v4 reserves its last configured decision round for canonical synthesize-or-block validation; a controller that still produces no synthesis output fails with `dynamic_incomplete`. Historical v3 exhausted runs remain readable as `exhausted_without_output`.

Not implemented: `/workflow continue` and `/workflow delegate`. Use `status`, `show`, `logs`, `wait`, `stop`, `resume`, and `pi-workflow inspect` for text/CLI inspection. The standalone CLI also offers `pi-workflow supervise <run-id>|--all` to drive scheduling from outside a Pi session (unfinished failed/interrupted or resumable blocked runs within the last 7 days are announced at session start with resume hints).

### Acknowledge unfinished-run notices

`/workflow notices list [--json]` lists eligible failed/interrupted root runs and dynamic-approval blocked runs, together with active or stale acknowledgements. It includes older runs even outside the session-start warning window. Copy the exact run id and SHA-256 state token from the list:

```text
/workflow notices acknowledge <exact-run-id> --state <sha256> --reason "Reviewed; preserving evidence without further action"
/workflow notices clear <exact-run-id>
```

The standalone `pi-workflow notices` commands have the same arguments and behavior and do not start a Pi supervisor or schedule work. Put `--reason` last; all following text is the required per-run reason (maximum 2,000 characters). Paths, run-id prefixes, batch acknowledgements, and blank reasons are not accepted. `list` and `clear` support `--json`.

Acknowledgements live only in `.pi/workflows/notice-acknowledgements.json`, separate from run records, artifacts, attempts, and existing notice timestamps. They bind the exact run id, status, update time, and SHA-256 of `run.json`. Only the unchanged acknowledged state is suppressed; changed state or new failures are eligible for warnings normally. Existing warning limits remain seven days, six-hour repeat deduplication, and five displayed runs. Clearing removes only that run's acknowledgement; normal warning deduplication still applies.

Acknowledging is **not** completion, archiving, stop/resume approval, or a prohibition on resuming. Status, inspect, and history stay visible and unchanged. Invalid sidecar data suppresses no warnings; list and mutation report errors rather than overwrite it. Concurrent mutations serialize with a dedicated bounded lock and preserve unrelated entries. An abandoned lock requires manual inspection; it is not automatically reclaimed. Symlinked application-owned paths and non-regular or hard-linked evidence files are rejected. These local checks do not isolate against a hostile same-user process continuously replacing filesystem ancestors.

### Options and modes at a glance

Slash-command flags and LLM-tool parameters are different interfaces; do not transfer an option between them unless it is listed here.

| Surface | Selection | Model/thinking | Named profile | Completion/background controls |
|---|---|---|---|---|
| `/workflow auto` (interactive) | Transmission authorization, then recommendation, workflow-only choice, and final launch confirmation; headless slash use fails closed before classification | Current runtime defaults for the authorized single comparison and selected launch | Selected named workflow follows normal saved/declared profile precedence | No `--detach`; selected run can later be waited on |
| `/workflow run` (interactive or print) | Exact named workflow; no classifier; retired route flags reject | `--model`, `--thinking` | Saved user profile; explicit declared `--profile` wins | Launch, then `/workflow wait`; `--detach`, `--force-new` |
| `/workflow dynamic` (interactive or print) | Exact direct dynamic runtime; no classifier; retired route flags reject | `--model`, `--thinking` | Not applicable | Launch, then `/workflow wait`; `--detach`, `--force-new` |
| `workflow_run` tool | Exact named workflow | Inherits session/spec; no model/thinking parameters | Saved user profile; explicit declared `profile` wins | `awaitTerminal` + optional `timeoutMs`, or `detach` |
| `workflow_dynamic` tool | Exact direct dynamic runtime | `model`, `thinking` | Not applicable | `awaitTerminal` + optional `timeoutMs`, or `detach` |
| `workflow_wait` tool | Not applicable | Not applicable | Not applicable | `runId`, optional `timeoutMs`; session-bound wait only |
| `pi-workflow` CLI | No launch command | Not applicable | Not applicable | `inspect` and `prune` accept `--json`; `supervise` drives existing runs with `--poll-ms`, `--max-runtime-ms`, and a run ref or `--all` |

Scalar launch selectors (`--model`, `--profile`, `--thinking`, including its `--reasoning` alias) cannot be repeated, even with the same value or split across leading/trailing options. `--route` and `--no-route` are retired and reject outside quoted task text; use `/workflow auto "<task>"` for a recommendation. Quote task text containing literal option names. Both prune interfaces reject repeated scalar filters, unknown arguments, and invalid numbers: `--keep` requires a non-negative safe integer (at most `9007199254740991`), while `--older-than` accepts finite non-negative days, including fractions. Blank values are invalid. CLI supervise likewise rejects duplicate scalar options and a run ref combined with `--all`; `--poll-ms` accepts decimal integers from `250` to `2147483647`, and `--max-runtime-ms` from `1000` to `2147483647`.

Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. A tool's `timeoutMs` on launch requires `awaitTerminal: true`; waiting and detaching are mutually exclusive. With no saved user profile, interactive declared-profile omission offers the legacy selector; without one, omission uses the declared default or base spec. Saved user profiles apply equally to interactive, print/headless, and `workflow_run` launches. For print/RPC/headless use, prefer text/tool results (`status`, `show`, `logs`, `inspect`) over interactive board controls; approval requiring a UI can block. `--json` is not a general slash-command launch flag.

### Workflow board controls

The `/workflow` board is read-only with respect to workflow state. It has four drill-down levels: runs, stages, tasks, and task detail, plus an explicit launch-command viewer.

| Key | Action |
|---|---|
| `Enter` / `→` | Drill into the selected run, stage, or task. |
| `b` / `Esc` / `←` | Go back one level. |
| `↑` / `↓` | Move within the current list or scroll the task artifact. |
| `[` / `]` or `p` / `n` | Move to the previous/next sibling run, stage, or task where supported. |
| `r` | Refresh run state from `.pi/workflows`. |
| `v` in runs or stages | Verify and open the selected run's captured launch command. Raw command text is never shown in the narrow summary panes. |
| `c` in the launch viewer | Copy the exact verified command. Copy is unavailable until the viewer has been opened explicitly. |
| `←` / `→` in task detail | Switch between task output and prompt artifacts. |
| `q` | Close the board. |

New slash-command runs record typed creation-launch metadata in `run.json`, but the exact extension-visible command is kept only in the private `launch-command.txt` sidecar. Legacy explicit run/dynamic launches use strict v1 metadata. Confirmed `/workflow auto` named/dynamic launches use strict v2 metadata with source `auto`, routing mode `auto-confirmed`, and opaque candidate/task/runtime selection facts; v1 is not widened to accept auto values. The captured form is `/workflow`, one canonical separating space, then the exact argument string Pi supplied; Pi does not expose a collision suffix such as `/workflow:1` or the original prefix separator, so this is extension-boundary fidelity rather than editor-byte fidelity. Natural-language `workflow_run` and `workflow_dynamic` launches record structured tool provenance but intentionally have no synthesized command. Existing runs and API/nested runs without explicit launch metadata show **unavailable (not captured)**; pi-workflow does not reconstruct launch history from specs, prompts, selection records, or transcripts. Missing, malformed, permission-widened, or integrity-mismatched sidecars fail closed as unavailable.

The launch viewer escapes terminal control and bidi characters for display, while `c` copies the exact unescaped verified text. Commands may contain sensitive user input. Clipboard retention is controlled by the OS or terminal and is outside pi-workflow's run retention. Sidecar checks reject symlinked components, hard-link substitution at commit checkpoints, widened permissions, and persistent path replacement. As with other same-user local state, they do not claim isolation from a hostile same-UID process that can continuously mutate directory ancestry between filesystem syscalls.

## Workflow resolution

A workflow ref can be either a path or a name.

Path refs:

```text
/workflow validate .pi/workflows/release-readiness.json
/workflow run ./workflows/my-workflow.json "Do the task."
```

Name refs use the first priority root that contains a match:

1. `<cwd>/workflows/` — repo-tracked, project-shared workflows
2. `<cwd>/.pi/workflows/` — project-private workflows
3. `~/.pi/agent/workflows/` — user/global workflows (under `$PI_CODING_AGENT_DIR/workflows/` when Pi's config-directory override is set; user agents under the same root's `agents/` follow it too)
4. bundled package `workflows/`

A higher-priority name shadows matches in lower-priority roots. Resolution fails closed as ambiguous only when more than one matching spec exists at the winning priority (for example both flat and bundle forms for the same name in one root); a lower-priority duplicate does not make the name ambiguous.

Workflow specs are JSON-only. Use `.json` for direct path refs, named discovery, and bundle `spec.json` files; `.yaml` and `.yml` workflow specs are not supported.

A workflow can be a direct spec path, but bundled reusable workflows should use directory bundles:

```text
workflows/deep-review/
  spec.json

workflows/deep-research/
  spec.json
  helpers/
    claim-evidence-gate.mjs
```

Bundle names resolve from the directory name. Multiple matching forms at the winning root fail closed as ambiguous; duplicates in lower-priority roots are shadowed according to the order above.

## Running workflows

Recommended workflow selection flow:

```text
/workflow list
/workflow validate deep-review
/workflow run deep-review "Review the current diff for security, reliability, and test coverage."
```

A run prints a `workflow_*` id. Use that id for follow-up commands:

```text
/workflow status workflow_mq224pi8_775e71
/workflow wait workflow_mq224pi8_775e71 600000
/workflow show workflow_mq224pi8_775e71
/workflow logs workflow_mq224pi8_775e71 task-1 120
```

The runtime task is not optional. `/workflow run <workflow>` and `/workflow dynamic` without task text fail before launch.

To interrupt a non-terminal run and stop its local supervisor watch, use
`/workflow stop <run-id>`. Resume later with `/workflow resume <run-id>` if
unfinished tasks should be retried.

### Diagnose a failed run

Start with the run summary, then inspect only the failing task before resuming:

```text
/workflow status <run-id>
/workflow logs <run-id> <task-id-or-spec-id> 120
/workflow show <run-id>
```

For a terminal-friendly evidence view, run
`pi-workflow inspect <run-id> --results` (every task's result envelope) or
`pi-workflow inspect <run-id> --failures --results` (failure detail; on a run
with no failures it falls back to every task's result and says so). After fixing the reported
access, configuration, output, or code problem, use
`/workflow resume <run-id>`; completed task artifacts are preserved. A run executes
its copied `bundle/` snapshot, so installing a newer pi-workflow version does not
replace that run's schemas or support helpers. If the failure was fixed in newer
workflow bundle code, start a fresh run rather than editing historical run or
bundle artifacts.

### Speed and quality guardrails

Performance changes must preserve final prompt/state/error semantics and the evidence gates that define output quality. Do not claim general speed or quality parity from one workflow, fixture, model, or concurrency regime. Default changes require candidate-matched paired runs with the same task, model/thinking, and serial-or-parallel regime; zero missing/duplicate verifier rows and source-ref join failures; no verified-floor regression; and explicit owner/release approval. Do not obtain a speed result by weakening verification, reclassifying partially supported claims as verified, skipping rows, shortening correctness timeouts/retries, or enabling opt-in streaming/batching/tiering by default.

### Environment inventory

Set user controls before launching Pi/supervisors so their child processes inherit the intended configuration. These controls do not override workflow evidence gates or grant additional tool authority.

| Classification | Variables and behavior |
|---|---|
| Supported configuration | `PI_CODING_AGENT_DIR`: Pi user configuration root, including workflow/agent discovery. `PI_WORKFLOW_STRICT_PROMPT_SCHEMA=1`: reject selected prompt/schema diagnostics before named-workflow launch (not direct dynamic); ordinary validation still applies. |
| Supported cache/transcript controls | `PI_WORKFLOW_FETCH_CONTENT_CACHE=0`: disable the bundled legacy fetch cache (`PI_WORKFLOW_FETCH_CACHE` is a fallback alias when the primary variable is unset). `PI_WORKFLOW_FETCH_CONTENT_INLINE_CHARS`: inline legacy fetch cap, default `12000`, `0` disables. `PI_WORKFLOW_DYNAMIC_TOOL_RESULT_BUDGET_CHARS`: dynamic child transcript cap; see [telemetry](#dynamic-child-transcript-budget-telemetry). |
| Supported operational limits | `PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES`: positive launch-gate override. `PI_WORKFLOW_MAX_LIVE_MODEL_WORKERS`: optional positive live-worker ceiling. `PI_WORKFLOW_TRANSIENT_MODEL_FAILURE_RETRIES` and `PI_WORKFLOW_ARTIFACT_OUTPUT_RETRIES`: non-negative retry limits, defaults `5` and `2`. Lower retries or higher concurrency are explicit reliability/quality trade-offs, not recommended speed defaults. |
| Experimental, default off | `PI_WORKFLOW_EXPERIMENTAL_TOOL_DEDUP`, `PI_WORKFLOW_EXPERIMENTAL_CACHE_STABLE_FOREACH`, `PI_WORKFLOW_EXPERIMENTAL_LAUNCH_RAMP`, `PI_WORKFLOW_EXPERIMENTAL_SAME_SESSION_REPAIR`, `PI_WORKFLOW_PER_ITEM_DISPATCH`; additionally `PI_WORKFLOW_ADAPTIVE_LIVE_WORKERS` enables adaptive live-worker limits. Enable with `1`, `true`, `yes`, or `on` (case-insensitive). No general speed/quality claim is implied. |
| Inactive experiment labels | `PI_WORKFLOW_CACHE_SHAPE_METRICS` and `PI_WORKFLOW_EXPERIMENTAL_DEPTH_ROUTER` do not enable runtime behavior. Provider cache usage is recorded when available without these flags. |
| Internal/diagnostic, not public tuning contracts | `PI_WORKFLOW_ROLE` and parent-subagent context are runtime-owned. `PI_WORKFLOW_CAPTURE_TOOL_CALLS`, `PI_WORKFLOW_SUBAGENT_EXTRA_EXTENSIONS`, `PI_WORKFLOW_CONTAIN_DETACHED_SUPERVISOR`, and `PI_WORKFLOW_LAUNCH_SLOT_RELEASE_DELAY_MS` are diagnostic/integration controls. Private runtime-artifact name/clone/copy controls belong to worktree implementation, not portable workflow specs. Leave internal controls unset unless an integration explicitly owns them. |

### Execution profiles

There are two compatible profile layers:

1. A workflow may declare custom-named `executionProfiles` in its spec. Each stage override may contain **only** `model`, `thinking`, and `foreachBatch`; absent properties inherit normally. `defaultExecutionProfile`, when present, must name one declared entry.
2. A user may run `/workflow profile [workflow]` and save one of five definition-specific choices: Codex, Codex High, Claude, Mixed, or Custom. With no workflow argument, the picker shows workflow names and current saved-profile labels rather than filesystem paths. Profile choices always stay in Codex → Codex High → Claude → Mixed → Custom order; the cursor focuses the saved or last-browsed choice without moving it. Pickers and previews share the same theme accent, body, and muted colors and the same responsive width (at most 100 terminal columns); the preview separates stage, role, model, and thinking into responsive columns. These choices synthesize model/thinking overrides from authored `profileRole` values; they do not rewrite the workflow spec or Pi's global model setting. When a declared default carries non-model metadata such as `foreachBatch`, the user profile overlays its model/thinking values without dropping that metadata.

Launch precedence is: an explicit declared `--profile` (or `workflow_run` `profile`), then the saved user profile, then the existing omitted behavior (interactive declared-profile selector, or declared default/Base without a selector). Explicit `--model`/`--thinking` runtime overrides remain highest for runtime values. A saved profile never silently substitutes a missing model or clamps an unsupported profile thinking level: the launch explains the incompatible stage/model pair and blocks. This strict check is local to the new saved profile layer; existing declared-profile and runtime requested/resolved/clamp behavior is unchanged.

The built-in role matrix is exact:

| `profileRole` | Codex | Codex High | Claude | Mixed |
|---|---|---|---|---|
| `planning` | `openai-codex/gpt-5.6-sol` / `high` | `openai-codex/gpt-5.6-sol` / `xhigh` | `anthropic/claude-opus-4-8` / `high` | `anthropic/claude-opus-4-8` / `high` |
| `research-execution` | `openai-codex/gpt-5.6-luna` / `medium` | `openai-codex/gpt-5.6-sol` / `high` | `anthropic/claude-opus-4-8` / `medium` | `openai-codex/gpt-5.6-luna` / `medium` |
| `synthesis` | `openai-codex/gpt-5.6-luna` / `high` | `openai-codex/gpt-5.6-sol` / `xhigh` | `anthropic/claude-opus-4-8` / `high` | `anthropic/claude-opus-4-8` / `high` |
| `verification` | `openai-codex/gpt-5.6-luna` / `high` | `openai-codex/gpt-5.6-sol` / `xhigh` | `anthropic/claude-opus-4-8` / `high` | `openai-codex/gpt-5.6-luna` / `high` |
| `final-judgment` | `openai-codex/gpt-5.6-sol` / `xhigh` | `openai-codex/gpt-5.6-sol` / `xhigh` | `anthropic/claude-opus-4-8` / `high` | `anthropic/claude-opus-4-8` / `high` |

Custom begins from the most recently selected built-in combination, restores its saved draft on later visits, and is not reset while browsing built-ins. Each stage's model and thinking can independently be fixed or inherit the current Pi value at the next run's start. The picker previews paged stage assignments and filters fixed thinking choices through Pi's actual model capability metadata. The native Custom model picker opens on the current setting in a bounded, scrolling list. Type provider/model words to filter locally, use arrows or Page Up/Page Down to navigate, and inspect the wrapped selected-model label below the list. Resizing keeps the highlighted selection in view; an empty search result cannot be selected. Esc goes back one screen: thinking → model (when editing both) → field → stage → preview → profiles → workflows. With an explicit workflow argument, profiles is the entry screen; otherwise workflows is the entry screen. Esc at the entry screen closes the flow. Back keeps completed Custom draft edits within the profile flow but discards an incomplete stage assignment when leaving its field editor; returning to the workflow picker discards the unsaved flow. Only **Save for next run** persists settings. Esc and failed validation do not save. Opening, editing, previewing, and saving do not start a workflow or provider call.

Declare `profileRole` on every model-backed `single`, `foreach`, `reduce`, and `dynamic` stage. Put it on the outer `foreach` stage (the selected runtime values are applied to `each`), on nested DAG/loop child stages, and on a loop's model-backed `onExhausted` stage. A dynamic stage's role classifies its generated-agent runtime defaults; for a dynamic decision loop, also put it on every present `planner`, `workerDefaults`, `verifier`, and `synthesis` profile object. Do not put it on support nodes or `dag`/`loop` containers. `profileRole` is semantic and independent of agent-context `role`; stage names are never used as a fallback. Missing or invalid coverage blocks only the saved user-profile feature with an actionable error, so older specs and their declared `executionProfiles` retain prior behavior.

Saved settings live under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/workflow-profiles/v1/` as private atomic files keyed by a canonical SHA-256 of the workflow definition excluding only its top-level comparison-only `routing` metadata. Adding, editing, or removing routing hints does not invalidate the selection; every other definition field remains identity-bound. Canonically identical definitions reuse the selection across projects; two workflows that merely share a name do not collide. Existing pre-routing settings and legacy full-definition settings matching the current definition are read without rewriting them; when both are compatible, the latest saved selection wins (canonical identity wins a timestamp tie). An explicit Save uses the new key and preserves the compatible Custom draft without deleting the legacy file. Unprovable legacy hashes and execution-definition changes at the same source path remain stale, not force-applied or automatically rewritten. Malformed, symlinked, or non-regular exact settings fail closed without overwrite; hash-named candidates encountered by the bounded same-path stale scan also block rather than being silently skipped. A new run resolves inherited values and writes the captured profile stage mapping into the run record and frozen compiled artifact; explicit launch-time model/thinking overrides remain separately authoritative. Changing user settings or Pi defaults later does not change an active run or resume.

`foreachBatch` is v1 profile-only batching, not a normal stage setting. It is valid only for a `foreach` target with `inputPolicy.artifactAccess: "none"`, and `maxItems` must be exactly `2`. The engine creates the batch prompt and result envelope; authors do not supply a batch prompt or envelope. A grouped pair is launched only when both adjacent logical items have the same usable `groupBy` value; if every fallback path is missing or empty, the whole would-be pair remains singleton. Missing, duplicate, extra, or individually invalid results discard the whole pair and rerun both items as singletons; one valid sibling is never accepted alone. A physical two-item launch still consumes two logical concurrency slots. Provider usage and timing are retained once on the durable batch record and attributed to its physical leader rather than double-counted across members. These constraints preserve ordinary per-item artifacts and downstream behavior.

### Deep-research execution profiles

`deep-research` explicitly declares `defaultExecutionProfile: "medium"`. When no user profile is saved, a headless omitted-profile launch uses `medium` and an interactive launch presents it first while still allowing the base spec. None of these declared profiles sets `model`, so current session/spec model resolution is retained. Their names are package conventions, not globally reserved names. A saved Codex/Claude/Mixed/Custom user profile instead overlays exact role-based model/thinking values on the `medium` default, preserving its verification batching; explicit `--profile low|medium|high` still wins:

```text
/workflow run --profile low deep-research "Research this repository and summarize the architecture tradeoffs."
/workflow run --profile medium deep-research "Research this repository and summarize the architecture tradeoffs."
/workflow run --profile high deep-research "Research this repository and summarize the architecture tradeoffs."
```

| Profile | Stage thinking and verification batching | Intended use |
|---|---|---|
| `low` | questions low; normalize medium; verify low; final-audit high; `verify-claims` batches pairs by first usable `$.sourceRefs` or `$.sourceUrls` | Latency/cost-sensitive exploratory work. Paired evaluations measured about 35% lower wall time and 25% lower task cost with equal aggregate verified claims, but one of three fresh prompts had a material completeness/actionability regression. This is an explicit quality trade-off, not quality-preserving mode. |
| `medium` | Base thinking: plan high; questions medium; normalize high; verify high; final-audit xhigh. `verify-claims` uses the same pair batching/fallback. | Recommended/default profile for decision-grade research. It leaves thinking inherited from the base stages and does not pin a model. |
| `high` | Base thinking except questions high and verify xhigh; `verify-claims` remains singleton. | More reasoning for research and verification. It is expected to be slower/costlier; a quality uplift over medium has not yet been measured. |

Do not combine `--profile` with blanket `--thinking` overrides unless you intentionally want the runtime override to replace stage-level profile choices. In every profile, deterministic evidence guardrails remain unchanged: `partially_supported` never counts as `verified`, and source-ref join integrity is still enforced.

Deep-research completion text is reader-facing: the conclusion, requested comparison, recommendations, and decision-relevant limitations. It does not repeat internal claim/slot totals, schema-cap accounting, claim IDs, or `evidence: derived` labels. Recommendations remain proposals, and unresolved or conflicting evidence still receives plain-language qualifications. Exact counts, denominator boundaries, synthesis caveats, and source/verification diagnostics remain in `audit.md` and structured controls; detailed findings remain in `final-report.md`.

Both research specs ask synthesis to distinguish the full audit `caveatNotes[].note` from an optional plain-language `readerNote` explaining its practical consequence. Completion displays at most four distinct reader notes, alongside deterministic warnings for incomplete, conflicting, or unknown evidence coverage. Older controls without reader notes remain readable using those conservative warnings rather than copying raw audit notes. This is presentation separation, not a change to verification thresholds, required reads, or canonical reconciliation. A historical run retains its original rendered artifacts and bundle; new output requires a new run, or an explicitly separate offline rendering preview.

Both research specs deliver final synthesis through `packet.synthesisInput.header` plus eight indexed `pages[0]`–`pages[7]`. Each of these nine `workflow_artifact` projections is required exactly once with `maxChars: 24000`, including empty tails. Page entries retain whole canonical array rows or whole non-array metadata values, identified by field and array index; no text or collections are shortened. The renderer requires exact reconstruction of every canonical packet field outside `synthesisInput`, including claim support, evidence, corrections, identities, slots, questions, gaps, and preserved leads.

The fixed bank supports at most 192,000 serialized UTF-16 units across the eight pages (including page framing), plus the separately bounded header; tool envelopes add transcript overhead outside those selected-value caps. Eight pages accommodate realistic near-max ledgers (48 claims, up to 64 planned slots and 24 questions), including the 48/56/22 scale regression, but are not a universal capacity guarantee: schema alternatives permit unbounded text. An indivisible row/metadata value above the per-read cap, or an exhausted bank, emits a typed `header.budgetBlock` and prevents successful rendering while preserving canonical data. Missing, truncated, duplicate, or tampered pages cannot substitute for complete delivery. Do not recover with a larger/root read or weaken the read obligations.

### Internalized experimental batched verification variants

Workflow-specific path-ref batched variants are not part of the public package surface. Their custom planners and batch schemas remain internalized. Public batching uses the profile-only transparent `foreachBatch` runtime contract above; generic primitives such as `foreach`, `matrix`, `fanout`, and multi-query web-source tool calls remain supported where documented.

### Opt-in tiered verification for deep-research

`deep-research` still runs every verifier task at the same pinned thinking level by default; verifier tiering as a default remains blocked by the [speed and quality guardrails](#speed-and-quality-guardrails). For controlled experiments where tiered verifier effort is acceptable, use the explicit path-ref variant:

```text
/workflow validate ./workflows/deep-research/tiered-verification.spec.json
/workflow run ./workflows/deep-research/tiered-verification.spec.json "Research this repository and verify the key claims."
```

The spec schema pins thinking per stage, not per foreach item, so this variant splits verification into two stages: a deterministic `verification-tiers` helper partitions sanitized candidates by their existing `verificationNeed` signal (`core` feeds `verify-core-claims` at high thinking; `useful`/`optional` feed `verify-tail-claims` at medium; candidates without a signal fall back to position order, first 8 to the core tier). Both stages use the same single-claim verifier prompt, the same control schema, `artifactAccess: none`, and the same verified-requires-url-plus-quote rule, and the audit gate consumes both stages' verifier rows. It is not registered as an official bundled workflow name and does not change package defaults. Treat speed/cost results as task-specific: claim a win only when the run's audit reports zero missing/duplicate/invalid verifier rows, zero sourceRef join failures, and no verified-floor regression. Any default adoption additionally requires a paired canary (same tasks, defaults vs variant, serial runs) before flipping anything.

### Verification outcome ontology

The package exports a small verification outcome vocabulary for workflows that verify source-backed claims: `verified`, `partially_supported`, `unsupported`, `conflicting`, and `verification_blocked`. Bundled workflow helpers must use bundle-local shims that stay in parity with the package export, because helper imports are bundled from the workflow spec directory. `verification_blocked` means the verifier could not evaluate the claim because required evidence, source access, tool execution, or policy constraints blocked verification. It is not a weaker form of `verified`, never counts toward verified floors, and should remain visible in audit summaries so operators can decide whether to rerun, change source access, or treat the claim as unresolved.

Adopt this vocabulary only for evidence-verification outcomes. Do not force it onto workflow-control, finding-disposition, or ship-readiness verdicts such as `KEEP`, `DROP`, `READY`, or `NEEDS_WORK`.

### Run-scoped web-source cache

Prefer normalized workflow web tools in new workflows:

- `workflow_web_search` returns compact candidate cards.
- `workflow_web_fetch_source` caches one or more URLs and returns compact source cards with `sourceRef` values; pass `urls: [...]` or `sources: [{ url, title }]` to batch several fetches in one tool call.
- `workflow_web_source_read` reads narrow exact/fuzzy/term-matched evidence snippets by `sourceRef`; pass `queries: [...]` or `reads: [...]` to batch several snippets from the same source in one tool call, or `claim` + distinctive `terms` when the exact quote is unknown. Term/claim reads return candidate metadata (`matchedTerms`, `missingTerms`, `coverageRatio`) rather than a proof verdict. Snippet windows are anchored to the match: a result may report `status: "truncated"` when the per-task visible budget or `maxChars` clips the window (the returned quote still starts at the match), and `status: "budget_exhausted"` when no visible budget remains; both include a `next` hint suggesting smaller queries or a fresh task.

The normalized cache is stored under the workflow run directory:

```text
.pi/workflows/<run-id>/web-source-cache/
```

Do not instruct agents to read that directory directly; source cards intentionally expose only opaque refs and short previews. The cache also writes an append-only index ledger plus serialized source-identity locking so duplicate lookup and deterministic terminal failures can recover across parallel worker processes. Custom normalized search providers are captured in declaration order; only selected passthrough tools are re-exported, so unselected provider tools do not leak. Local provider refs resolve against workflow cwd and must identify one existing extension file. Custom `fetch_content` ownership for normalized fetch is intentionally unsupported: preparation rejects it before provider dispatch because `allowPrivateHosts: false` cannot sandbox an arbitrary extension transport. The built-in direct-safe fetch client remains the only normalized fetch transport.

The default normalized fetch path uses the independent `pi-workflow-direct-safe-fetch` client. Its effective policy is `pi-workflow-strict-public-http-v1`, and that fetcher/policy provenance is retained on source cards, including duplicate and reloaded cards. It preserves pi-workflow's own public-host validation, redirect revalidation, DNS rebinding checks, and deadline. It intentionally does **not** inherit pi-web-access auth profiles, answer/fetch routing, hosted providers, proxy trust, domain policy, `ssrf.allowRanges`, or private-host enablement. Setting `securityPolicy.allowPrivateHosts: true` for this default direct path fails closed during initialization. Private targets are not implicitly enabled by provider metadata.

Legacy workflow tasks that still use `fetch_content` keep the older run-scoped file cache under `.pi/workflows/<run-id>/source-cache/fetch-content/` only for the bundled `pi-web-access` provider. `readable` and `raw` modes use separate cache identities. Custom/extension providers remain functional pass-through calls, but caching is disabled because no stable fingerprinted cache contract exists; this prevents shared namespaces, unknown-argument collisions, and replay of provider-owned IDs. Answer mode, any call with an own `auth` property (regardless of its value), URL userinfo, fragments, and recognized credential/signature/session query parameters bypass workflow cache reads, writes, events, and directory creation. Authenticated response bodies never enter workflow-cache state. Because pi-web-access also disables its stored-content cache for authenticated fetches by default, a successful auth cache-off result may omit `responseId`; do not assume it is present. Set `PI_WORKFLOW_FETCH_CONTENT_CACHE=0` to disable the bundled legacy workflow cache for a run.

To reduce worker context pressure for legacy `fetch_content` tasks, the bundled
workflow fetch wrapper caps inline response text while preserving full stored
source content. Override with `PI_WORKFLOW_FETCH_CONTENT_INLINE_CHARS=<n>` or
disable the inline cap with `PI_WORKFLOW_FETCH_CONTENT_INLINE_CHARS=0` when you
intentionally need the provider's full inline response.

When a `responseId` is present, use paginated `get_search_content` calls rather than requesting an unbounded body. Select a URL with `url`/`urlIndex`, pass integer `offset` and `limit`, and continue at `details.nextOffset` while `details.truncated` is true. Workflow-mapped pages are normalized at UTF-16 surrogate boundaries; a `limit` of 1 over an astral character still advances and reports coherent `returnedChars`, `nextOffset`, and continuation values. For targeted passages, use `findText` (one string or a bounded string array) and optional `findMode` (`exact`, `case-insensitive`, or `fuzzy`). `findText` cannot be combined with `offset`/`limit`, and `findMode` requires `findText`. Workflow response-ID aliases are private run-cache files (`0700` directory/`0600` files), lazily rehydrated with a fresh provider-storage timestamp; tampered aliases fail closed and unmapped web IDs remain pass-through.

## Bundled workflows

`pi-workflow` ships a small official starter set, not a comprehensive workflow catalog. Create project-local or repo-shared workflows under `.pi/workflows/` or `workflows/` when your team needs patterns that are not bundled.

| Workflow | Required agents | Mode | Use when |
|---|---|---|---|
| `deep-research` | `researcher` | plan + foreach questions + normalize-input packet support + normalize + foreach verifier + audit support + final-audit packet support + compact final synthesis reduce + deterministic ledger-backed executive render | Use when you need a grounded answer or summary based on source material. |
| `deep-review` | `scout` | triage + foreach review lenses with typed required-source coverage + dedup support + foreach devil's advocate + verdict-partition support + bounded report-packet support + no-repository-tool synthesis + deterministic full-ledger render | Use when you want code or design reviewed carefully from multiple angles. Unreadable or metadata-only required sources force a partial verdict and appear in the final report. |
| `spec-review` | `scout` | extract spec + map implementation + inspect tests -> reduce candidates -> foreach verifier -> reduce report | Use when you want to check whether requirements, an API spec, or a contract are reflected in the implementation and tests. |
| `impact-review` | `scout` | scope/implementation/validation maps -> impact lenses -> consistency/regression/ship-readiness joins -> final synthesis | Use before merging or releasing a change to check affected areas, risks, missing tests, and missing docs. |

Bundled starters use local-first Pi agent discovery with bundled fallback
agents. Project `.pi/agents/` definitions win, then user
`~/.pi/agent/agents/`, then pi-workflow's bundled common agents (`scout`,
`researcher`). Customize the workflow when you need a different role or
stricter tool ceiling.

### Agent resource inheritance

For newly compiled runs, agent frontmatter `inheritSkills: false` disables
initial ambient skill discovery in the child Pi process (`--no-skills`).
Omitting it or using `true` preserves ordinary discovery; it does not copy
the parent's loaded skills. Existing saved runs, including their resumed
attempts and generated children, retain their original behavior even if
an agent previously declared `false`. Start a new run to adopt the opt-out.

This is a discovery control, **not complete resource isolation**. Required
extensions and tools remain enabled; extensions can still add explicit
skills after discovery. Project context remains disabled with
`--no-context-files` regardless of `inheritProjectContext`. That flag does
not suppress every supplemental resource such as `APPEND_SYSTEM.md`.
`inheritProjectContext: true` and invalid inheritance values produce warnings,
not context activation or validation errors. Dynamic-agent warnings are
recorded in the saved compiled workflow when the agent is generated.

The effective policy is bound to the prepared launch and versioned launch
provenance; changing or omitting it after preparation is rejected. Legacy
provenance is not automatically rewritten. These controls do not enable the
experimental foreach cache layout or establish provider cache hits or savings.

### Local review evidence

`spec-review` accepts typed local `evidence` and `counterEvidence` rows shaped as `{file, lineStart, lineEnd, quote, relevance?}`; each verifier array allows at most 64 rows. KEEP/WEAKEN require verified typed evidence, DROP requires verified typed counter-evidence before removal, and positive requirement coverage also requires typed bytes. Every typed citation must pass: one good quote cannot hide another failed citation. Legacy strings, including plausible file:line locators, URLs, and opaque web refs, remain display-only/unverified. They may accompany typed evidence but cannot replace it; preliminary mapping and no-issue notes are not conformance proof. This gate does not fetch or attest remote bytes.

The `spec-review` bundle and the `support-partition` authoring scaffold carry equivalent closed-bundle `local-evidence-reader.mjs` readers. They verify current local UTF-8 bytes under canonical workflow cwd, rejecting escapes, symlinked descendants, nonregular files, files over 4 MiB, invalid UTF-8, cancellation, and observed file/ancestry mutation. Descriptor reads are bounded to 64 KiB chunks with at most 4 MiB + 1 byte allocated. Inclusive 1-based ranges split on LF, retain CR, BOM, diff markers, and whitespace, and never clamp past EOF; a terminal LF creates an empty last line. A quote must be an exact substring wholly within the declared range, not normalized text. Spec-review requires both range endpoints; only the scaffold permits omitted ranges as explicitly file-wide evidence, not symbol attestation. This proves current byte presence, not semantic entailment, historical worker access, or isolation from a continuously racing hostile same-user process.

Partition retains per-row `evidenceGate` results (`spec-local-evidence-v1`) and file SHA-256 values; ungrounded dispositions remain in `needsHuman`. Requirement reconciliation requires exactly one explicit `requirementId`/`status` row per unique exact ID in the bounded runtime-attested extract-spec control; titles, order, aliases, and normalized IDs are not identity. Status is `covered`, `gap`, `partial`, `unclear`, or `needsHuman`. `covered` requires valid typed bytes. `gap`/`partial` identify known missing behavior and can complete as `GAPS_FOUND` only with grounded KEEP/WEAKEN explicitly linked to that real requirement; DROP alone cannot resolve a gap or make it covered. `CONFORMS` requires every extracted requirement positively covered. Unclear/unresolved rows, missing/duplicate/unknown/invalid coverage IDs or statuses, invalid extracted IDs, or absent scope/proof remain `INCONCLUSIVE`/failed. The renderer independently rereads the runtime source chain, reconciles the exact requirement set and control-byte binding, and rechecks citations before `actionableEvidenceComplete` or `passed`. Missing/forged/stale reconciliation (including historical controls), changed bytes, or an absent/inconsistent report cannot produce a clean completion. Runtime candidate-source status and the candidate task's source manifest must also account for extract-spec/map-implementation/inspect-tests: failed, missing, or inconsistent required sources cannot be hidden by a clean model-authored candidate control. The report and `source-ledger.json` preserve this audit trail.

Spec extraction declares local `specSources` and supplies typed `specEvidence` file/range/quote citations for each requirement. Requirement text or a source label alone is not grounding. The retained runtime proof binds the candidate universe and the extract/map/test control snapshots. An empty candidate/verifier join can complete as `CONFORMS` only when the runtime candidate control independently proves zero and every requirement has positive byte-backed coverage. Empty arrays supplied by a report or partition are not that proof. Business IDs retain their exact case even when runtime task locators are normalized.

Candidate and report stages require the declared bounded artifact projections, including empty tail slices. Read every listed projection; a whole-root or truncated read is not a substitute for a different required path. Full authoritative controls remain in the artifacts, separate from compact report projections.

## Stage model

Public `schemaVersion: 1` workflows use `artifactGraph.stages` as the only authoring surface.

### Auto-comparison hints

A workflow may optionally declare top-level author-controlled comparison hints; they describe when the existing workflow fits but do not grant authority, alter execution, or expose its prompt text:

```json
{
  "routing": {
    "useWhen": ["Reviewing a broad code change for grounded defects."],
    "avoidWhen": ["Making a small direct patch."],
    "outputs": ["A deduplicated review report with evidence."]
  }
}
```

Each of `useWhen`, `avoidWhen`, and `outputs` is optional, contains at most 12 unique non-empty strings, and each string is at most 480 UTF-8 bytes with no control characters. After structured transmission authorization, `/workflow auto` compares the bounded authored `description` and routing hints with declared output/schema/verification markers and stage-count/fan-out overhead proxies. Those fields are untrusted data only; it does not inspect arbitrary prompts, helpers, controllers, local source paths, or bundle bytes during recommendation. Omit `routing` when no concise authored guidance is available.

`fast: "on"` is intentionally unsupported in workflow specs; omit `fast` or use `"off"`/`"inherit"` where runtime defaults expose the field.

Public workflow definitions separate three layers:

- **Workflow layer**: graph/control/data-dependency fields such as `id`, `from`, `after`, `sourcePolicy`, `sourceProjection`, scheduling, and artifacts.
- **Subagent layer**: child Pi/model worker shapes: `single`, `foreach`, `reduce`, and `loop`.
- **Support layer**: local helper execution through a stage that declares a `support` object.
- **Dynamic layer**: trusted bundle-local controller code that can adaptively add official workflow tasks at runtime.

Every subagent stage writes artifact bundles:

- `control.json` — strict machine-readable control-plane JSON. Deterministic workflow decisions read this file only.
- `analysis.md` — prose reasoning/evidence for humans and downstream readers.
- `refs.json` — structured evidence pointers.
- `raw.md` — captured final-answer artifact; see Retention for raw-read assurance.

| Node | Layer | Data behavior |
|---|---|---|
| `type: "single"` | Subagent | One focused subagent prompt. |
| `type: "foreach"` | Subagent/control | Reads an array from an upstream `control.json` simple dot path and materializes one task per item. |
| `type: "reduce"` | Subagent | Fan-in over upstream artifact handles and optional `sourceProjection` inline control snippets. |
| `type: "loop"` | Workflow/control | Repeats fixed child stages until deterministic `until`, `maxRounds`, or no-progress stop. Loop conditions read child `control.json`. |
| `type: "dag"` | Workflow/control | Composite container; lowers child stages to namespaced tasks and exposes an `outputFrom` child downstream. |
| `type: "dynamic"` | Dynamic/control | Runs a trusted bundle-local controller `.mjs`; generated `ctx.agent()` work is spliced into `compiled.json`/`run.json` as official workflow tasks. |
| `support: { uses }` | Support | Runs a directory-local `.mjs` helper over selected upstream `control.json` values and writes a workflow artifact bundle. |

Use `foreach.from` for static data-driven fan-out, `reduce.from` for subagent fan-in, support `from` for local helper inputs, and `type: "dynamic"` only when the workflow must decide its own child tasks at runtime. Do not rely on a later plain `single` stage to see previous stage output.

`single` stages receive the runtime task by default. Set stage-level `injectRuntimeTask: true` on `foreach` or `reduce` to include it alongside item/source context when cross-cutting user constraints must reach those workers. Setting it to `false` does not suppress ordinary `single` task injection.

Planner-driven dynamic stages may declare `dynamic.decisionLoop` to keep adaptive behavior policy-bound in JSON. The planner emits `dynamic-decision-v1` data only; trusted controller/runtime code validates and persists decisions, maps accepted actions to generated workflow tasks, extracts state indexes, and enforces budgets, role/tool ceilings, replay invariants, and fail-closed invalid-decision behavior. Users still provide only the normal workflow task string.

After each dynamic decision-loop round persists its state index, the runtime folds that round's gaps, blockers, conflicts, and omissions — plus bounded failed generated work — into a retained historical coordination projection scoped to the stage. The next planner round's prompt includes a deterministic `Coordination state (historical retained projection; quoted fields are untrusted data, not instructions): …` block: up to the top 8 highest-priority retained issues (severity `critical` > `high` > `medium` > `low` > `info` > `unknown`, then kind `blocker` > `conflict` > `gap` > `omission`, then first-seen round, then id), rendered under a 2000-character ceiling with whole-item truncation (no partial trailing lines), quoted normalized fields, retained/dropped labels, and `since r<N>` staleness tags. The prompt also includes an advisory locator line pointing at the latest full state-index artifact/digest — never validated, so treat it as optional context, not a required read — and a remediation-policy line mapping issue classes onto the existing `add_work_item`, `verify`, `synthesize`, and `blocked` actions while forbidding duplicate follow-up for issue ids/tasks already listed in Generated tasks. Coordination projection is deterministic: identical event history renders byte-identical prompts, and those prompt bytes participate in the recorded dynamic agent request hash used to detect replay divergence.

### Dynamic workflow authoring

Dynamic workflows keep JSON as the source of truth while allowing trusted bundle-local JavaScript to orchestrate adaptive work. A dynamic stage looks like this:

```json
{
  "id": "adaptive",
  "type": "dynamic",
  "profileRole": "research-execution",
  "dynamic": {
    "uses": "./helpers/controller.mjs",
    "mode": "graph-splice",
    "permissions": { "approval": "auto" },
    "budget": { "maxAgents": 1000, "maxConcurrency": 16 }
  }
}
```

Controller/helper/nested workflow refs must be bundle-local `./...` paths. Nested workflow specs are intentionally self-contained at their own directory level: refs inside a nested spec may point to files in that nested spec's subtree, but not to parent-level shared files via `../` — put shared helpers/schemas under each nested workflow subtree or expose them through the parent controller/helper layer. Controller/helper code is trusted Node.js code for orchestration and timeout isolation, not a security sandbox.

Controller context rules:

- Generated agents are real workflow tasks: `ctx.agent({ id, agent, prompt, tools })` inserts a deterministic `stageId.id` task into `compiled.json` and `run.json`, persists a request hash in `dynamic/events.jsonl`, and replays fail-closed if the same id later changes request shape.
- On resume, controllers must re-issue previously recorded `ctx.agent`, `ctx.helper`, and `ctx.workflow` operations in the same order before issuing new operations; omitted or out-of-order replay fails closed with an explicit replay-invariant error.
- Use `ctx.parallel([() => ctx.agent(...), ...])` for dynamic fan-out; the runtime records queued sibling generation ops before the controller suspends, and non-suspension operation failures make the controller fail closed. Generated dependency cycles are rejected.
- `ctx.helper(name, input)` can call only helpers declared in `dynamic.helpers`; pure/retry-safe helpers may set `idempotent: true` so a crash after `helper.started` but before `helper.completed` can retry the helper instead of permanently failing closed.
- `ctx.workflow(name, input)` can call only nested specs declared in `dynamic.workflows`.

Dynamic outputs should be compact typed artifacts. The controller returns normal workflow sections through `{ control, analysis, refs }`; generated child agents must return the same `<control>`, `<analysis>`, `<refs>` protocol as other artifact-graph tasks. When a controller result includes `outputTasks`/`outputTaskIds` (the built-in decision loop sets this from accepted `synthesize` actions), downstream `from: "<dynamic-stage>"` reducers also receive those exported task artifacts as stable sources such as `<dynamic-stage>.output`. Runtime state is stored under `.pi/workflows/<run-id>/dynamic/`:

- `events.jsonl` — append-only decisions such as controller status, task generation, helper completions, nested workflow starts, and approvals.
- `state.json` — replayable projection/cache of controller status, generated task ids, and budget counters.
- `controller.log` — JSONL records from `ctx.log(...)`, useful for controller debugging.

Approval modes:

- `approval: "auto"` is the default.
- `approval: "ask"` uses Pi's interactive `ctx.ui.confirm` and records the approved dynamic scope, including the full task digest and run-bundle fingerprint. Approving the controller authorizes this controller's generated agents to run without later approval prompts; generated agents run non-interactively within the displayed roles/tools and budgets. Read-only generated agents use the shared workspace; mutation-capable generated agents and agents using Pi-default tools use managed worktrees. Nested workflows keep their own approval policy and may still block for approval. Pure headless scheduling fails closed with `dynamic_ui_unavailable`; missed/timed-out prompts fail closed with `dynamic_approval_timeout`. `/workflow resume <run-id>` from an interactive Pi session retries either blocked approval state.

Budgets bound controller behavior (`maxAgents`, `maxConcurrency`, `maxRuntimeMs`, `maxNestedWorkflowDepth`, `maxGraphMutations`, `maxHelperRuns`). `maxNestedWorkflowDepth` limits actual ancestor-relative depth, not cumulative sibling calls: depth 1 permits sibling children but prohibits grandchildren. Each ancestor's remaining allowance is inherited and cannot be widened by a child. Parent-owned launch ledgers establish ancestry; missing, corrupt, or ambiguous legacy ancestry grants no new descendant headroom. Depth is nonconsumable headroom, not a sibling-work cap; the other work/runtime/tool budgets still apply. Suspended child-agent wait time does not count as active controller runtime. `ctx.budget.remaining()` reports current headroom, including inherited depth and live generated-agent concurrency from the run record; `ctx.budget.check()` returns false when any reported dimension reaches zero. `allowDynamicRoles` and `allowDynamicTools` default to enabled under the trusted-code model and are enforced when disabled: controller attempts to choose generated agent roles or override tools fail.

Do not use dynamic depth counters as launch authority. Hot state reads/writes project only the local ledger: `counters.nestedWorkflowDepth` is 0 or 1 according to local child registrations, without traversing descendants. Full retained historical descendant depth is computed only by an explicit runtime inspection call, `readOrRebuildDynamicState(cwd, runId, { observeDescendants: true })`. That observational result is not persisted back into the hot cache and never grants execution authority; it is not a private-module import recommendation.

### DAG authoring

Top-level `artifactGraph.stages` is DAG-capable by default. A nested `type: "dag"` is a workflow/control container, not a leaf subagent task: it must contain child `stages` and should not have its own prompt. The runtime lowers public graph relationships onto the internal dependency scheduler while preserving artifact/data boundaries. Keep the authoring layers described under "Stage model" distinct when composing DAGs.

DAG rules:

- `from` is a data + order edge. Downstream artifact-graph stages receive a `workflow_artifact` manifest and digest-only inline source list; deterministic runtime decisions read upstream `control.json`.
- `after` is order-only. It accepts a string or string array, waits for those stages, and does not make their artifacts available as source data. A task that declares `inputPolicy.requiredReads` or `requiredReadPolicy` for an `after`-only source fails before worker launch; add the source to `from` when artifact access is required.
- `after: []` is an explicit parallel root. It opts out of the implicit previous-stage chain while documenting that the stage intentionally has no ordering dependency.
- Parse-time graph validation rejects unknown stage references, self-dependencies, duplicate stage ids, dependency cycles, unsupported output fields, and unsafe `controlSchema` paths.
- `inputPolicy.requiredReads` is fail-closed: if declared, the task must read each listed `source.artifact` via `workflow_artifact` before its final output is accepted. String entries require a non-truncated read of that source/artifact. Object entries can additionally require exact `count`; JSON artifacts (`control`, `refs`) can require `path`, `maxChars`, and `maxItems` using `$` or simple dot paths such as `$.items`. When `maxChars` or `maxItems` is declared, `path` is required. A truncated required read never satisfies the policy: the runtime always rejects a ledger row whose read was truncated, so `mustNotTruncate` documents this always-on behavior rather than toggling it (setting `mustNotTruncate: false` does not permit a truncated read to pass). The runtime does not preload required artifact contents into the prompt; it exposes source refs and checks the read ledger. Direct repo `read`/`grep` calls do not satisfy this proof; the ledger proves artifact access, not semantic use. DAG container outputs use the selected child source name, for example `analysis.final.analysis` for `id: "analysis", outputFrom: "final"`. Required-read source names inside nested `type: "dag"` containers are namespaced the same way as child runtime sources (for example child `scan.control` lowers to `analysis.scan.control`).
- `sourceProjection.include` can inline small selected simple dot paths from upstream `control.json` (for example `$.digest` or `$.items`); `$` selects the whole control value, including empty/scalar roots, still subject to `maxChars`. A simultaneous narrower include does not reduce a root selection. Full artifacts remain available through `workflow_artifact`.
- `inputPolicy.terminalBarrier: "all-sources"` is an explicit fan-in policy. The stage waits until every declared dependency is terminal before ordinary `sourcePolicy` evaluation; one failed source does not prematurely cancel the join. Omit it to retain the default first-blocking-source behavior.
- `inputPolicy.invalidateOnDependencyResume: true` opts a static artifact-graph consumer into generation-bound replay. Resuming a dependency transactionally quarantines stale consumer artifacts, increments its generation, and rematerializes stable foreach ownership through a durable journal. The runtime fails closed rather than crossing unsupported dynamic, loop, streaming-foreach, or ambiguous ownership boundaries. Omit it to retain ordinary resume behavior.
- `inputPolicy.maxCompiledPromptChars` places a positive code-point cap on the final compiled prompt, including projected source context and retry repair text. Compilation rejects a statically oversized prompt and runtime compilation rejects a dynamic overflow.
- A non-streaming `foreach` may set `each.itemIdentityPath` to a simple string-valued item path such as `$.id` for duplicate-safe stable child identities, and `each.itemPayloadPath` to a different simple object-valued path such as `$.payload` for prompt interpolation. Duplicate, unsafe, missing, non-string identity, non-object payload, and resulting task-id collisions fail closed. Omit both fields to preserve index-based identity and the full item payload.
- A `type: "dag"` stage may contain `single`, `foreach`, `reduce`, support nodes, or nested `dag` stages. Loops are top-level workflow/control stages in v1. Child `from`/`after` references resolve only to siblings inside the same container.
- `outputFrom` names the child whose task keys represent the container for downstream `from: "containerId"` edges. If omitted, exactly one sink child defaults as the output; multiple sink children require explicit `outputFrom`.

For `workflow_artifact` JSON projections, `maxChars` and `projection.originalChars` count serialized JavaScript string units (UTF-16), unlike JSON Schema string bounds, which count Unicode code points. The default projection limit is 51,200 units, not a hard ceiling: an explicit per-read `maxChars` can request a larger complete projection when the stage policy permits it. Check `truncated` and the projection metadata; never count a partial read as complete or evade an explicit stage cap. Budget serialized JSON escaping and all permitted schema alternatives, not only ordinary ASCII fixtures.

Example diamond plus a DAG container consumed downstream:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "agent": "scout",
    "readOnly": true,
    "tools": ["read", "grep", "find", "ls"]
  },
  "artifactGraph": {
    "stages": [
      {
        "id": "plan",
        "type": "single",
        "profileRole": "planning",
        "prompt": "Put machine-readable JSON in <control> with an items array."
      },
      {
        "id": "scan",
        "type": "foreach",
        "profileRole": "research-execution",
        "from": { "source": "plan", "path": "$.items" },
        "each": { "prompt": "Scan this item: ${item}" }
      },
      {
        "id": "review",
        "type": "single",
        "profileRole": "verification",
        "after": "plan",
        "prompt": "Run an independent review after planning finishes."
      },
      {
        "id": "merge",
        "type": "reduce",
        "profileRole": "synthesis",
        "from": ["scan", "review"],
        "sourceProjection": { "include": ["$.digest"] },
        "prompt": "Merge both branch outputs."
      },
      {
        "id": "analysis",
        "type": "dag",
        "from": "merge",
        "outputFrom": "final",
        "stages": [
          { "id": "scan", "type": "single", "profileRole": "research-execution", "prompt": "Scan the merged findings." },
          { "id": "review", "type": "single", "profileRole": "verification", "after": "scan", "prompt": "Review after the scan without scan output context." },
          { "id": "final", "type": "reduce", "profileRole": "synthesis", "from": ["scan", "review"], "prompt": "Summarize the analysis children." }
        ]
      },
      {
        "id": "report",
        "type": "reduce",
        "profileRole": "final-judgment",
        "from": "analysis",
        "inputPolicy": {
          "requiredReads": [
            {
              "source": "analysis.final",
              "artifact": "control",
              "path": "$.summary",
              "maxChars": 4000,
              "count": 1
            }
          ],
          "enforcement": "fail"
        },
        "prompt": "Write the final report using the analysis control artifact."
      }
    ]
  }
}
```

## Output contracts

Artifact-graph subagent stages must return the workflow output section protocol:

```text
<control>{"schema":"stage-control-v1","digest":"..."}</control>
<analysis>Detailed reasoning and evidence discussion.</analysis>
<refs>[]</refs>
```

By default the engine requires exactly one `<control>`, then one `<analysis>`, then one `<refs>` section, with no prose outside the tags. It writes `control.json`, `analysis.md`, `refs.json`, and `raw.md`, and retries/fails invalid output within the stage retry budget. `control.digest` is required and bounded by `output.maxDigestChars`.

`output.analysis.required: false` and `output.refs.required: false` make those sections optional, not forbidden. Supplied sections must still appear at most once in canonical control/analysis/refs order and satisfy their normal content rules. Omitted optional analysis/refs are stored as empty analysis and an empty refs array. Positive `refs.minItems` still requires refs. Support helpers may emit all three sections even when analysis or refs is optional.

Markdown fences do not escape the final section protocol. When quoting a complete protocol response inside analysis, encode its literal `<` characters as `&lt;`, while leaving the actual outer tags unescaped. For example, quote `&lt;control>{...}&lt;/control>` rather than a nested unescaped control section. Genuine duplicate sections remain invalid.

Use workflow-local JSON Schema files when the control plane needs stronger validation:

```json
{
  "output": {
    "controlSchema": "./schemas/questions-control.schema.json",
    "analysis": { "required": true },
    "refs": { "required": true }
  }
}
```

The built-in validator supports the subset used by bundled workflows: `type`, `required`, `properties`, `items`, `enum`, `const`, length/item/number bounds, `additionalProperties`, and simple `allOf`/`anyOf`/`oneOf`. Unsupported keywords such as `$ref`, `$defs`, `definitions`, and `pattern` are rejected when the workflow is loaded. Malformed values of supported keywords are also load errors. Object `const`/`enum` equality ignores property insertion order; array order still matters. String length bounds count Unicode code points, not UTF-16 units or grapheme clusters.

When a control schema constrains `control.schema` with `const` or `enum`, that value is the semantic output protocol identifier; it is independent of the schema file's basename. Model prompts and examples must emit the exact constrained value rather than deriving one from `output.controlSchema` (for example, `stage-control-v1`, not `questions-control.schema`).

### Opt-in partial output for streaming foreach

A producer stage can declare stable array paths that may be published before terminal completion:

```json
"output": {
  "partial": { "paths": ["$.items"] }
}
```

A downstream `foreach` may then opt in on the matching `from` edge:

```json
"from": {
  "source": "plan",
  "path": "$.items",
  "streaming": { "enabled": true, "minChunk": 2 }
}
```

Emit each `<partial-control>…</partial-control>` publication as a standalone block before final output sections, outside code fences and inline prose. Progress prose may separate publication blocks. Literal partial-control markers inside final control/refs JSON or analysis are data, not publications. Identical items may be republished, but published items must not change or disappear.

The runtime accepts only partial items for declared paths. Published partial items must be final/stable JSON objects with a non-empty string `id`; the producer may emit them as `<partial-control>{"schema":"workflow-partial-output-v1","path":"$.items","items":[...]}</partial-control>` before the final workflow output. If the final `control.json` later changes a published item with the same id, the streaming foreach placeholder blocks fail-closed. Downstream reducers still wait for the foreach placeholder plus all generated item tasks, so partial output overlaps item work without relaxing final fan-in gates.

By default, a streaming foreach child whose stage declares `sourceProjection` or `requiredReads` (with artifact access enabled) still waits for the producing stage to complete, because its projection/read context does not exist before the producer's final control is written. Setting `PI_WORKFLOW_PER_ITEM_DISPATCH=1` opts in to per-item dispatch for such projection-dependent children: when every `sourceProjection.include` path is also a declared producer `output.partial.paths` entry and already has published partial items, the child is activated per item and its projection is served from the producer's durable partial output ledger (marked `projectionSource: "partial-ledger"` in the source manifest). Children whose projection paths are not yet satisfiable from partials — and any stage with `requiredReads`, which need on-disk producer artifacts — keep the default completed-producer barrier. The activation decision is made once at materialization and persisted, item change/withdrawal checks are unchanged, and no bundled spec enables this flag. This is a mechanism-only opt-in; it carries no speed or cost claim (see the speed-change checklist before claiming any).

## Support helpers

A support node runs local helper code inline instead of launching a subagent. It is declared by adding a `support` object; it does not use a separate `type` value:

```json
{
  "id": "audit-claims",
  "from": "verify-claims",
  "sourcePolicy": "partial",
  "support": {
    "uses": "./helpers/claim-evidence-gate.mjs",
    "options": { "requireFetchedEvidenceForVerified": true }
  }
}
```

Helper API:

```js
export default async function helper({ sources, options, context }) {
  return { schema: "helper-output-v1", digest: "...", value: { /* control data */ } };
}
```

For artifact-graph workflows, `sources` contains upstream `control.json` values keyed by stable source names. The helper result is normalized into a workflow artifact bundle, so downstream deterministic readers still consume `control.json`. Async helpers receive `context.signal`, an `AbortSignal` for cooperative `/workflow stop` cancellation; observe it and return or throw promptly when aborted. In-process helpers cannot be force-killed while running uncooperative synchronous JavaScript; process isolation would be required for that guarantee.

Helper refs must start with `./`, end in `.mjs`, and stay inside the workflow bundle directory. This is path containment, not a security sandbox: helper code runs unsandboxed inside the workflow process, has Node.js process permissions, is not constrained by subagent tool allowlists, and should only be bundled from trusted repository code. Legacy `type: "transform"` specs are rejected with a migration error; move the helper ref to `support.uses` and options to `support.options`.

## Loop behavior

A `loop` stage repeats a fixed child stage subgraph once per round.

Required loop fields:

- `id`
- `maxRounds`
- `until`
- at least two child `stages`

Child stage ids are materialized as deterministic runtime ids such as:

```text
fix-loop.r01.implement
fix-loop.r01.check
fix-loop.r02.implement
fix-loop.r02.check
```

Loop child stages run strictly in listed order. Nested `loop`, `foreach`, `dag`, and support children are rejected in v1. There is no `parallel` stage type; model parallel branches as multiple roots or with `after: []`.

Minimal shape (the `until` condition must reference the final child stage):

```json
{
  "id": "doc-sync",
  "type": "loop",
  "maxRounds": 2,
  "until": { "stage": "draft", "path": "$.consistent", "equals": true },
  "stages": [
    { "id": "compare", "type": "single", "profileRole": "verification", "prompt": "...", "output": { "controlSchema": "./schemas/compare-control.schema.json" } },
    { "id": "draft", "type": "single", "profileRole": "synthesis", "prompt": "...", "output": { "controlSchema": "./schemas/draft-control.schema.json" } }
  ]
}
```

Data flow inside a loop is implicit, not authored:

- Loop children must not declare `from` or `after`; validation rejects them. Each child depends on the previous child of the same round, so its runtime sources are that round's earlier children (for example `doc-sync.r01.compare` for `draft` in round 1), readable through `workflow_artifact` like any other source.
- The first child of round N (N > 1) depends on every task of round N-1, runs with `sourcePolicy: "partial"`, and receives a `# Loop Carry-Forward Context` block: the previous round number, the designated check stage, the progress metric, the check stage's latest structured output (compact JSON, bounded to about 4,000 characters), and a rolling summary. Later children in a round do not receive that block.
- Round 1's first child inherits the loop stage's own dependencies.

`until` grammar:

- Leaf: `{ "stage": "<final-child-id>", "path": "$.field", ... }` plus one predicate: `equals` / `notEquals` (string, number, boolean, or null, compared with `Object.is`), `lengthEquals` (integer, array or string length), or `exists` (boolean). If several predicates are present only the first in the order `exists`, `equals`, `notEquals`, `lengthEquals` is evaluated; a leaf with no predicate, no `path`, or an unreadable value never matches. `source` is accepted as an alias for `stage`; the referenced child must be the final child stage, and `path` uses the same `$`-prefixed simple dot/bracket syntax as `foreach.from`, read from that child's `control.json`.
- Combinators: `{ "all": [ ...conditions ] }` and `{ "any": [ ...conditions ] }` nest leaves or further combinators. Every nested leaf must reference the existing final child stage; when both `source` and `stage` are supplied, they must agree.
- Put the `until` path in the final child's control schema and show it in that stage's few-shot example; a missing path evaluates as not satisfied and the loop runs to `maxRounds`.

A loop stops when:

- `until` evaluates true (`loopStates[].status: "completed"`),
- `maxRounds` is exhausted (`"exhausted"`),
- no-progress detection fires (`"stopped_no_progress"`): from round 2 on, the metric at `progressPath` (default `$.blockingFailures`; array/string length or a finite number) read from the designated check stage's control is compared with the previous round and the loop stops when it did not decrease,
- or a blocking failure prevents scheduling.

An optional `onExhausted` stage runs once when the loop ends by exhaustion or no progress. Round count and outcome appear in `/workflow status`, `/workflow show`, and `run.json` `loopStates`. `/workflow resume` does not support loop workflows yet, so fix the spec and start a fresh run instead of resuming an interrupted loop.

There is no auto-merge. Managed worktree output is recorded for human review.

## Run artifacts

Workflow state is file-based under:

```text
.pi/workflows/<run-id>/
```

Important files:

| File | Purpose |
|---|---|
| `run.json` | Canonical run record: status, task summary, task records, fanout/loop/dynamic metadata, run timestamps, and optional structured creation-launch metadata. Exact commands are never stored here. |
| `launch-command.txt` | Optional exact slash-command capture for a new slash launch. Stored as a private `0600` file in the run's `0700` directory and integrity-linked from `run.json`; absent for tool, legacy, ordinary API, and nested launches. |
| `compiled.json` | Compiled workflow snapshot. |
| `spec.json` | Workflow spec snapshot used by the run. |
| `tasks/<task-id>/task.md` | Compiled task prompt. |
| `tasks/<task-id>/system-prompt.md` | Compiled system prompt. |
| `tasks/<task-id>/control.json` | Machine-readable control artifact for artifact-graph tasks. |
| `tasks/<task-id>/analysis.md` | Human-readable reasoning/evidence artifact. |
| `tasks/<task-id>/refs.json` | Structured evidence pointers. |
| `tasks/<task-id>/raw.md` | Captured final answer before section extraction; legacy scoped reads do not attest original bytes. |
| `tasks/<task-id>/read-ledger.jsonl` | `workflow_artifact` read proof used by `requiredReads`. |
| `tasks/<task-id>/source-manifest.json` | Upstream artifact manifest visible to the task. |
| `tasks/<task-id>/output.log` | Captured worker output from the subagent attempt; may share its inode. |
| `tasks/<task-id>/stderr.log` | Captured worker stderr. |
| `tasks/<task-id>/result.json` | Structured task result envelope and artifact pointers. |

Subagent worker artifacts are stored under `.pi/workflow-subagents/` by default and are referenced from the workflow run record.

### Retention

Nothing is deleted automatically. Run `pi-workflow prune` or `/workflow prune` to preview terminal runs beyond the retention window; add `--yes` to delete them. Task `output.log` and `raw.md` may share storage only within the runtime's bounded run/task/attempt link contract. Raw reads validate exact ownership and source identity, canonical containment, and complete inode-link accounting; arbitrary, external, unaccounted links and observed substitutions fail closed. New host-owned publication requires a trusted host-recorded digest: a result-sidecar digest alone is not authority, and failed owner establishment cannot silently produce fresh legacy data. Link failures after valid ownership can use independent authoritative bytes while retaining their host binding.

Raw read results and read-ledger rows include `rawAssurance`. `host_digest_verified` means the complete bytes match the trusted host binding, even when the returned view is truncated. Known legacy layouts expose their current scoped contents as `legacy_scoped_unattested`, with `originalBytes: "unattested"`; this does not attest historical final-answer bytes. Low-level writers without host publication context use independent storage and report `independent_unattested`, not host verification. These checks do not migrate old data, expand the allowed filesystem scope, prove semantic correctness, or authenticate an arbitrarily falsified host record. Do not infer assurance or physical savings from a filename, and do not rewrite historical artifacts by hand.

Retention keeps the newest 50 terminal runs by default; `--keep` changes that count, and `--older-than` additionally restricts deletion to older terminal records. Preview is read-only: it acquires no topology/supervisor leases and performs no quarantine, deletion, or index write. Destructive pruning coordinates with first run publication through a workflow-root topology lease and checks candidate supervisor leases and generation identity again before detachment. Live or indeterminate supervisor leases protect a run. Every retained child protects its ancestors, regardless of child status; selected children purge before parents, and failed child purges or retained primary quarantines continue to protect ancestry. Unknown, unreadable, ambiguous, or cyclic references are protected rather than guessed. Preview conservatively reports retained-child protection instead of simulating successful child deletion.

Prune JSON distinguishes canonical detachment from successful purge: `detached: true` alone does not mean `deleted: true` or `purged: true`. A pre-detach failure retains the canonical run and may leave a quarantined mirror; a post-detach failure can leave both quarantined trees. `retainedEvidencePath` and `retainedMirrorPath`, when present, identify recovery evidence and are also printed in text. Any canonical detachment triggers an index refresh even if purge fails; a recreated same-ID generation is preserved. Unprotected selected-run failures produce `summary.error` and CLI exit 1. `deletedBytes` credits only fully purged candidates, never retained quarantine bytes; partial purge may therefore understate freed bytes. Retention recovery is manual: inspect the reported paths and current generation before restoring or removing evidence. Prune neither automatically restores over a new run nor automatically deletes retained recovery evidence.

All four bundled workflows use a common completion envelope while preserving workflow-specific verdicts and evidence models. A successful final renderer writes a compact `completionSummaryMarkdown` for lossless parent handoff and `final-report.md` as the stable user-facing sidecar; completion delivery appends its safe project-relative path and any declared evidence-audit path. The first detailed section is **Executive summary**, evidence and limitations remain explicit, and supporting links appear only in the final **Related artifacts** section. `deep-research` keeps byte-identical `executive.md` plus its claim-level `audit.md`; `deep-review` keeps byte-identical `review.md`; `spec-review` and `impact-review` keep their canonical source controls in `source-ledger.json`. Missing, partial, contradictory, or incompletely rendered canonical ledgers fail or block the final support task instead of producing a clean completion.

## Token usage tracking

Usage is provider-reported only. Displayed totals focus on token counts; cost
is not shown because provider cost coverage and semantics vary, and no cost is
ever derived from token counts or model names. Usage is recorded at three levels:

- **Per task** (`run.json` → `tasks[].usage`): each subagent attempt's usage is
  captured from the pi-subagent result envelope and aggregated across retries.
  Requires `@agwab/pi-subagent` >= 0.4.7, which sums per-request usage across
  every turn of a run; older engines reported only the final request, so token
  counts recorded before the upgrade undercount multi-turn tasks.
- **Per run** (`run.json` → `usage`): when a run reaches a terminal status, a
  `task-rollup` record is persisted with summed token totals and
  `tasksReporting`/`taskCount` so partial coverage is visible.
- **Parent session** (`.pi/workflows/<run-id>/parent-usage.json`): the pi
  session that started the run records its own assistant-turn usage (auto comparison,
  waiting, summarizing) into this sidecar while the run is active, finalizing
  on the wrap-up turn after the run turns terminal. It is a separate file
  because a detached supervisor owns `run.json`. When several runs are active
  in one session, each run's sidecar attributes the same parent turns, so
  sidecars of overlapping runs should not be summed blindly.

Parent accounting resumes only for the matching persisted `sessionId`; another session cannot adopt its totals, and legacy sidecars without an owner remain readable but frozen. Writes serialize under topology and sidecar leases. Failed deltas remain queued in memory and retry before later operations on the next message or flush; durable `messageIds` receipts commit with totals to prevent duplicate counting on retry or identified message replay. Failed flush/detach does not discard pending deltas. Tracking is dropped when the run is removed or its directory generation is replaced, with checks repeated under the retention topology lease: late usage does not recreate pruned storage or cross into the replacement run.

Write failures surface the fixed sanitized warning “Parent usage accounting deferred after a write failure; pending totals will retry on the next message or flush. A sanitized diagnostic is saved with recovery.” Recovery persists only `lastWriteFailure: { code: "parent_usage_write_failed", at }`, not raw assistant content or exception text. The pending queue is not a durable outbox: uncommitted deltas can be lost on process exit/crash, and cross-process replay deduplication requires a stable message identity. Durable receipts do not guarantee recovery of never-committed usage.

Where it surfaces:

- The workflow board (`/workflow`) shows run totals plus the parent-session
  line in the run summary panes, a per-task token suffix in task lists, and a
  full token breakdown (in/out, cache read/write, attempts) in task detail.
- `/workflow status <run-id>` and run-start/terminal text output include a
  `usage=` line with `tasksReporting=N/M`.
- Nested workflows (a workflow running inside a subagent) attach the child
  task's usage totals to terminal `child.*` events on the parent subagent run
  (persisted by `@agwab/pi-subagent` >= 0.4.8; older engines ignore the field).

## CLI inspect

The terminal CLI reads local `.pi/workflows` run records without launching Pi commands:

```bash
pi-workflow inspect workflow_mq224pi8_775e71
pi-workflow inspect workflow_mq224pi8_775e71 --failures
pi-workflow inspect workflow_mq224pi8_775e71 --results
pi-workflow inspect workflow_mq224pi8_775e71 --json
```

`inspect` accepts a full run id or an unambiguous prefix.

`supervise` exits 0 for completed work, 1 for failed/interrupted work or its runtime deadline, and 2 for blocked work. In `--all` mode it tracks only top-level runs observed running during that invocation, ignoring historical terminal runs; failure takes precedence over blocked, and an empty batch succeeds.

## Authoring workflows

Use the bundled `workflow-guide` skill when creating or reviewing reusable workflows.

Project workflows can live in either project workflow root:

```text
.pi/workflows/<name>.json
.pi/workflows/<name>/spec.json
workflows/<name>.json
workflows/<name>/spec.json
```

Use `workflows/` for repo-committed shared workflows and `.pi/workflows/` for local/project-private workflows. Use the directory-bundle form when the workflow needs schemas, support helpers, or copied scaffold files.

`workflow-guide` ships validate-ready scaffolds under `skills/workflow-guide/scaffolds/`:

| Scaffold | Use when |
|---|---|
| `fixed-inventory` | A caller-fixed 1–8 document set needs one editorial stakeholder-question extraction per document plus a deterministic exact-owner join. Its initializer writes a runnable bundle without a provider call; do not use it for inventory discovery or factual/conformance judgment. |
| `foreach-reduce` | Extract a list of work items, verify each item, then synthesize a report. |
| `support-partition` | Candidate findings need deterministic partitioning/dedup after verifier verdicts. |
| `dag-required-reads` | A nested analysis DAG must expose one child output and force downstream artifact reads. |
| `matrix-dag` | Multiple review lenses should run in parallel and then join through reducers. |
| `object-tool-fallback` | A read-only workflow needs optional custom/web extraction fallback tooling. |

For `fixed-inventory`, create a binding containing only `name`, optional `description`, and exact `{id,path}` items, then run `node skills/workflow-guide/scaffolds/fixed-inventory/initialize.mjs <binding.json> <fresh-or-empty-destination>`. The initializer validates and copies known IDs, paths, schemas, helpers, joins, and rendering deterministically; it does not inspect documents, launch a model, or decide that the inventory is complete. Review and validate the output before execution. See the scaffold README for the exact boundary.

Authoring checklist:

1. Start from a bundled workflow when one fits.
2. Start from a scaffold when its topology matches the requested new workflow.
3. Decide the workflow graph first: subagent stages (`single`, `foreach`, `reduce`, `loop`), `dag` containers, dynamic stages when adaptive runtime orchestration is required, and support nodes when deterministic local helper code is needed.
4. Make every data dependency explicit with `foreach.from`, `reduce.from`, support `from`, or dynamic `ctx.agent`/`ctx.helper`/`ctx.workflow` calls.
5. Keep read-only workflows read-only.
6. For write-capable workflows, choose a worktree policy and validation stage.
7. Add JSON output contracts for model-produced data that later stages depend on.
8. Declare a semantic `profileRole` on every model-backed stage and dynamic decision-loop profile so all five user execution-profile choices remain available.
9. Run `/workflow validate <workflow-or-file>` before using the workflow.

### Roles

A workflow can declare reusable role context under top-level `roles`. Compiled role text is injected into subagent task prompts as a `# Role Context` block, and `/workflow roles <workflow>` shows the compiled result per role. Role fields:

- `fromAgent`: extract sections from a discoverable Pi agent's markdown body. By default only safe knowledge sections are included (`Core Principles`, `Domain Expertise`, `Safety Review`, `Rules`, `Research Manifest`); orchestration and output-format sections are always excluded.
- `includeSections` / `excludeSections`: override which agent sections are extracted.
- `prompt`: literal role text, appended after any extracted agent sections.
- `maxChars`: compiled role budget (default 12000). Longer content is truncated and flagged in `/workflow roles` output.

A model stage may select one or more declared roles with `role` (a string or string array). When omitted, all declared roles are retained for compatibility. A `foreach` stage's `each.role` replaces the stage selection for its generated workers. `each.agent`, `each.tools`, `each.model`, `each.thinking`, `each.maxRuntimeMs`, `each.readOnly`, and `each.worktreePolicy` likewise override the stage values on the generated worker template; runtime command-line overrides still have highest precedence. Unknown role names fail during compilation.

`profileRole` is a separate execution-profile classification; it does not select or alter the agent-context `role` above. Authors classify model work semantically as `planning`, `research-execution`, `synthesis`, `verification`, or `final-judgment`. Do not infer it from the stage id. See [Execution profiles](#execution-profiles) for placement and dynamic/nested addressing.

`defaults.cwd` and `stage.cwd` are resolved from the project invocation directory and emitted as absolute task working directories. Dynamic stages do not accept an explicit `cwd`.

### Tool allowlists

Workflow `tools` are still the child-worker allowlist. Entries can be strings:

```json
{ "tools": ["read", "grep", "workflow_web_search", "workflow_web_fetch_source", "workflow_web_source_read"] }
```

or object specs for custom/local providers:

```json
{
  "tools": [
    "read",
    {
      "name": "scrapling_fetch",
      "extensions": ["packages/pi-scrapling-access"],
      "classification": "read-only",
      "optional": true,
      "fallbackTools": ["workflow_web_fetch_source"]
    }
  ]
}
```

Scope order is agent frontmatter fallback < `defaults.tools` < stage `tools`: the most specific defined list controls the final tool names, and selected string names can inherit broader object metadata for the same tool. Agent frontmatter `tools` remain the hard ceiling, so workflow specs cannot grant tools an agent did not declare. Built-in classifications win for built-in tools. Custom tools without an explicit object `classification` stay blocked for explicit review. Avoid hardcoded machine-local paths in bundled/public workflows; project-local workflows may use local package refs intentionally when they are part of that project.

## Safety and execution model

- `/workflow` is an orchestrator, not an OS sandbox.
- Workers run through `@agwab/pi-subagent`; sandbox/worktree behavior follows that package.
- Workflow tool lists can only narrow agent-declared tool authority, even when object-form provider metadata is used.
- `readOnly: true` is a safety declaration used for capability/worktree classification; it does not isolate the filesystem or make mutation-capable tools safe.
- Write-capable workflows should use managed worktrees in git repositories.
- In non-git workspaces with `worktreePolicy: "off"`, writes mutate the live directory.
- No backend fallback exists. The compiled backend/strategy is fixed for the run.
- Subagent process launches are gated per Pi process to avoid boot storms: at most `max(2, floor(cpu cores / 2))` concurrent launches, overridable with the `PI_WORKFLOW_MAX_CONCURRENT_LAUNCHES` environment variable. Queued tasks report a waiting message in their status. Deterministic boot failures (extension load or configuration errors) fail fast instead of consuming transient-failure retries.
- External content, source files, and web pages used by workflow workers are untrusted data, not instructions.

### Durable launch and batch controls

Provider-capable launches require the bundled runtime's opt-in
`durable-launch-barrier-v2` API; the workflow does not silently downgrade to the
weaker v1 release protocol. The worker writes READY and remains paused before
Pi/provider initialization. An external grant digest is bound through the
descriptor, worker execution plan, READY receipt, and immutable gate decision.
The workflow durably records the provisional backend handle and execution-plan
digest, then commits consumed launch authority and the release payload before
competing for one exclusive `released`-or-`revoked` decision. A revocation that
wins this decision prevents worker execution. A release that wins remains visible
as `release_won_cancellation_pending` during later cancellation.

Workflow stop, lease loss, timeout, and fail-fast cleanup require both an explicit
interrupt result for the exact backend attempt and an observed terminal status for
that same attempt. `unsupported`, `not-found`, mismatched-attempt, and timeout
results leave cancellation pending and retain the durable stop intent and backend
handle. Crash recovery validates READY/decision/ACK receipts and never respawns the
attempt; incomplete stale barriers are revoked and reaped fail-closed. Startup
fails before spawn when v2 is unavailable or any bound receipt drifts.

Launch-bootstrap provenance also binds the canonical workflow state-root identity
(device, inode, owner, mode, canonical path, and private persisted nonce) and the
post-preparation effective tool-provider surface. Private state-root capabilities
are in-memory, unforgeable handles; persisted digests are evidence, not authority.

New transparent max-2 foreach batches persist a root-bound capability subject and
an immutable inspected schedule. A dispatch reservation is included in the same
durable commit that precedes barrier release. If recovery finds a reservation with
no terminal receipt, the exact batch is marked `non_reusable` and its items fail
closed instead of being silently relaunched. Legacy batch records remain readable
but do not gain authority from missing hardened fields.

## Web tools

New workflows should use `workflow_web_search`, `workflow_web_fetch_source`, and
`workflow_web_source_read` — tool semantics, batching forms, and the run-scoped
cache are documented under "Run-scoped web-source cache" above. The normalized
search result is an additive typed `ok | partial | empty | failed | cancelled`
envelope with bounded candidates, counts, truncation, and provider attribution.
Provider lists distinguish actual execution (`providers`) from requested selectors
(`selectedProviders`); reserved selectors `auto` and `all` are never accepted as
actual provider IDs, so attribution is unavailable without a concrete provider.
Cancellation is authoritative even while waiting for the durable budget lock or
ledger I/O: it returns zero candidates/usage and does not rewrite the ledger. Explicit source-read terms are limited to 16 per read, and a
combined source-read batch is limited to 20 requests; over-limit calls fail as
`invalid_params` rather than silently dropping evidence. Source cards retain the
validated effective redirect URL and aliases, so a later fetch by either the
requested or effective URL reuses the same source.

The visible source budget is durable per `(runId, taskId)` in the private run
cache. Each invocation uses a private counter and rebases its committed delta
under the short budget lock, so concurrent calls cannot corrupt telemetry.
Retries or resumed workers continue the same cumulative budget; a changed
configured limit fails closed, while a different task ID is isolated. Aggregate
`budget.truncated` is true only when visible text was clipped by `maxChars` or
remaining budget, not merely when an operation is partial or failed. The
visible-budget ledger's atomic rename is its commit point: cancellation before
rename wins; cancellation after rename observes the committed result.

The bundled `pi-web-access` adapter remains the default provider for legacy
`web_search`, `fetch_content`, and `get_search_content` calls. A custom legacy
provider is accepted only when one extension coherently owns every selected
legacy web tool; it is imported inside the generated cache wrapper with
`providerKind: "extension"`, while the bundled storage adapter remains in use.
Split, multiple, or incompatible ownership fails before child dispatch. Required
capabilities are validated by canonical tool name. If configuration renames or
disables a required canonical tool, launch fails fast before the first model or
provider-tool execution; pi-workflow does not guess compatibility from labels or
schemas. pi-workflow's separate narrow compatibility extension preserves the
legacy read-only `code_search({ query, maxTokens? })` surface through fixed Exa
transport; a code-search-only task does not load or gain the other provider
tools.

- Object-form custom tool `extensions` are merged with built-in mappings and deduplicated for the subagent launch.
- Web calls can still fail when network access, provider credentials, browser state, or quota are unavailable; research workflows should report those limits instead of guessing.
