# Gold-reviewed rescore

Source run: `.pi/eval/bug-forge/runs/geth-locked-controls-gpt55-codex-low-fast-20260617T155426Z`

Raw `score.json` files were not modified. Rescore uses expanded `geth-case-002` gold after provider review. Bug order is G2/G1/G3 to keep explicit Start-error findings from being greedily consumed by the broader lifecycle-race gold.

| Task | Arm | Score | Recall | Precision | FP | Matches | Missed | Extraction |
|---|---|---:|---:|---:|---:|---|---|---|
| geth-case-002 | plain | 0.941 | 0.833 | 1.000 | 0 | G2->0, G1->1 | G3 | json_block |
| geth-case-002 | self-check | 0.675 | 0.333 | 1.000 | 0 | G2->0 | G1, G3 | json_block |
| geth-case-002 | workflow | 0.675 | 0.333 | 1.000 | 0 | G2->0 | G1, G3 | candidate_json_sidecar |
| geth-case-004 | plain | 1.000 | 1.000 | 1.000 | 0 | G1->0 |  | json_block |
| geth-case-004 | self-check | 1.000 | 1.000 | 1.000 | 0 | G1->0 |  | json_block |
| geth-case-004 | workflow | 1.000 | 1.000 | 1.000 | 0 | G1->0 |  | candidate_json_sidecar |
| geth-control-001 | plain | 1.000 | 1.000 | 1.000 | 0 |  |  | json_block |
| geth-control-001 | self-check | 1.000 | 1.000 | 1.000 | 0 |  |  | json_block |
| geth-control-001 | workflow | 1.000 | 1.000 | 1.000 | 0 |  |  | candidate_json_sidecar |
| geth-control-002 | plain | 1.000 | 1.000 | 1.000 | 0 |  |  | json_block |
| geth-control-002 | self-check | 1.000 | 1.000 | 1.000 | 0 |  |  | json_block |
| geth-control-002 | workflow | 1.000 | 1.000 | 1.000 | 0 |  |  | candidate_json_sidecar |

## Mean objective score

- plain: 0.985
- self-check: 0.919
- workflow: 0.919
