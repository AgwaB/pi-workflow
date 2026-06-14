# Migration to artifactGraph workflows

`schemaVersion: 1` now means the artifact-graph public contract. Old `workflow.stages`, top-level `flow.type`, and legacy `output.format` authoring are rejected by the normal runtime.

## Top-level shape

Before:

```json
{
  "schemaVersion": 1,
  "agent": "scout",
  "readOnly": true,
  "tools": ["read"],
  "workflow": { "stages": [] }
}
```

After:

```json
{
  "schemaVersion": 1,
  "defaults": {
    "agent": "scout",
    "readOnly": true,
    "tools": ["read"]
  },
  "artifactGraph": { "stages": [] }
}
```

## Outputs

Before:

```json
{
  "output": {
    "format": "json",
    "contract": { "requiredPaths": ["$.items"] }
  }
}
```

After:

```json
{
  "output": {
    "controlSchema": "./schemas/items-control.schema.json",
    "analysis": { "required": true },
    "refs": { "required": true }
  }
}
```

The model returns a single final answer split into strict sections:

```text
<control>{"schema":"items-control-v1","digest":"...","items":[]}</control>
<analysis>Human-readable reasoning and evidence.</analysis>
<refs>[]</refs>
```

The engine writes `control.json`, `analysis.md`, `refs.json`, `raw.md`, and `result.json`.

## Edges

- `from` is data + order.
- `after` is order-only.
- `after: []` means explicit parallel root.
- `foreach.from` now uses `{ "source": "stage-id", "path": "$.items" }`.

## Required reads

Use `inputPolicy.requiredReads` when a stage must explicitly read upstream artifacts through `workflow_artifact` before its output can be accepted:

```json
{
  "inputPolicy": {
    "requiredReads": ["plan.analysis"],
    "enforcement": "fail"
  }
}
```

This proves a required artifact read occurred; it is not a semantic guarantee that the model used the artifact correctly.

## Support helpers

Before support-like transforms were represented by legacy transform shapes or implicit support nodes. Now use:

```json
{
  "id": "audit",
  "type": "support",
  "from": "verify",
  "support": { "uses": "./helpers/audit.mjs" }
}
```

For artifact-graph workflows, helpers receive upstream `control.json` values as `sources` and their return value is normalized into a vNext artifact bundle.

## Legacy flow.type

Do not migrate old `flow.type: "dag"` directly. Express it with `artifactGraph.stages`, `from`, `after`, and nested `type: "dag"` containers.
