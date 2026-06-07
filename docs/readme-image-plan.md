# README image plan

This is the working brief for README diagrams. The goal is to explain the execution model at a glance, not to document every runtime detail.

## Overall direction

- Keep diagrams schematic and low-detail, closer to “roughly how it works” than an architecture diagram.
- Prefer the term **workflow runtime** in explanatory labels. Use **Supervisor** only if the graphic needs a concrete box label, and avoid making it look like a user-configured agent.
- Do not draw child subagents directly calling each other. If arrows connect stage groups, label them as stage flow, source context, or runtime scheduling.
- Use `+N more` or `dynamic items`, not fixed counts like `+55 more`, unless the number comes from a specific run screenshot.
- Use **Workflow stage types**, not **subagent task type**.
- For `reduce`, prefer this label:

```text
source context fan-in · 1 subagent
```

Avoid:

```text
merge prior outputs
```

That can imply automatic semantic merging. More accurate copy:

```text
runtime collects source context; reduce subagent synthesizes it
```

## Suggested README image slots

### 1. `docs/assets/readme-stage-types.png`

Placement: after the `## Stage types` intro.

Purpose: teach the four primitives.

Layout: 2x2 card grid, like the clipboard reference, but with four cards instead of six.

Cards:

1. `task`
   - caption: `single prompt · 1 subagent`
   - graphic: runtime/stage box -> one child circle

2. `parallel`
   - caption: `fixed fan-out · bounded concurrency`
   - graphic: runtime/stage box -> three child circles

3. `foreach`
   - caption: `dynamic fan-out from JSON array`
   - graphic: prior JSON/output icon -> runtime/stage box -> several child circles + dashed `+N`

4. `reduce`
   - caption: `source context fan-in · 1 subagent`
   - graphic: several output/artifact icons -> `Source Stage Context` bundle -> one child circle

Important visual detail for reduce:

```text
prior outputs/artifacts --collected by runtime--> Source Stage Context --given to--> reduce subagent
```

The reduce subagent should look like the active synthesizer, not just the endpoint of automatic merge arrows.

Alt text:

```text
Four workflow stage types: task runs one subagent, parallel runs fixed concurrent subagents, foreach expands JSON items into dynamic subagent tasks, and reduce passes source context into one synthesis subagent.
```

### 2. `docs/assets/readme-stage-composition.png`

Placement: after `## Composing workflows`.

Purpose: show that simple stage types become larger workflows.

Recommended shape:

```text
task plan
  -> foreach research items
  -> reduce normalize
  -> foreach verify items
  -> reduce final
```

Visual style:

- Top row: five stage boxes with stage type subtitles.
- Bottom row: approximate child-run shape under each stage.
- Use labels `fan-out` and `fan-in` sparingly.
- Add one small note, not a big legend:

```text
stage order schedules work; source context is passed only where the workflow asks for it
```

If space is tight, skip bottom-row individual child circles and only show stage boxes plus fan-out/fan-in icons.

Alt text:

```text
A workflow composed from stage types: one plan task fans out into research tasks, a reduce stage normalizes claims, verification fans out again, and a final reduce stage synthesizes the report.
```

### 3. `docs/assets/readme-deep-research.png`

Placement: near the `deep-research at a glance` snippet or in the bundled workflows section.

Purpose: show one representative bundled workflow. This should be the only workflow with a detailed image in the main README.

Recommended content:

```text
deep-research
plan / task
research-questions / foreach
normalize-claims / reduce
verify-claims / foreach
final / reduce
```

Optional annotations:

- `researchQuestions[]` between `plan` and `research-questions`
- `claimsForVerification[]` between `normalize-claims` and `verify-claims`
- `Source Stage Context` into each reduce stage

Do not show exact caps like 12 questions or 96 claims in the main image. If a cap is needed, use `bounded by workflow`.

Alt text:

```text
The deep-research workflow plans research questions, runs dynamic research fan-out, reduces those outputs into normalized claims, verifies selected claims with another fan-out, and uses a final reduce stage to produce a cited report.
```

## Optional workflow gallery image

If the README later needs a stronger marketing-style image, add a compact workflow gallery instead of making every workflow fully diagrammed.

Possible file:

```text
docs/assets/readme-workflow-gallery.png
```

Layout: one row/card per workflow, each as a stage-chip sequence.

Examples:

```text
deep-research   task -> foreach -> reduce -> foreach -> reduce
deep-review     task -> foreach -> foreach -> reduce
migration       parallel -> reduce -> foreach -> reduce
implement       task -> reduce -> foreach -> reduce
best-of-n-fix   task -> foreach -> reduce
revise-loop     task -> reduce -> reduce -> reduce -> reduce
decision-debate task -> parallel -> reduce -> reduce
```

This should be optional because a table plus one representative workflow is usually clearer than seven mini diagrams.

## Copy rules for image labels

Preferred labels:

- `workflow runtime`
- `stage`
- `child Pi subagent`
- `artifact / result`
- `structured output`
- `Source Stage Context`
- `bounded concurrency`
- `dynamic items`

Avoid or use carefully:

- `Supervisor` as a big concept. It is accurate internally, but README readers may think they need to configure a supervisor agent.
- `merge outputs` for reduce. Use `fan-in`, `source context`, or `synthesize` instead.
- hard-coded fan-out counts in conceptual diagrams.
- direct subagent-to-subagent arrows unless they are clearly labeled as stage flow rather than child calls.

## README insertion once assets exist

Use relative paths so npm/GitHub rendering works:

```md
![Workflow stage types](./docs/assets/readme-stage-types.png)
```

```md
![Composing workflow stages](./docs/assets/readme-stage-composition.png)
```

```md
![Deep research workflow flow](./docs/assets/readme-deep-research.png)
```
