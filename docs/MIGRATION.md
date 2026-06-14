# Workflow format note

`schemaVersion: 1` is the first public `pi-workflow` artifact-graph contract.

Workflow specs use this top-level shape:

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

Subagent stages return vNext sections:

```text
<control>{"schema":"stage-control-v1","digest":"..."}</control>
<analysis>Human-readable reasoning and evidence.</analysis>
<refs>[]</refs>
```

The engine writes `control.json`, `analysis.md`, `refs.json`, `raw.md`, and `result.json` for each artifact-graph task.

Use `docs/usage.md` for the canonical authoring guide.
