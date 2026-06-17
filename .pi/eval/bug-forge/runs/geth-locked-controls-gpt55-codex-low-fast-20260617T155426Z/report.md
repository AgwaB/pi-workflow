# Bug Forge Calibration

Model: openai-codex/gpt-5.5
Thinking: low
Concurrency: 3
Workflow score stage: partition
Workflow no report: yes

Invalid cells are quarantined from interpretation; their objective scores are diagnostic only.

| Task | Arm | Valid | Score | Recall | Precision | FP | Extraction | Status | Invalid reasons |
|---|---|---|---:|---:|---:|---:|---|---:|---|
| geth-case-002 | plain | yes | 0.740 | 1.000 | 0.500 | 1 | json_block | 0 |  |
| geth-case-002 | self-check | yes | 0.090 | 0.000 | 0.000 | 1 | json_block | 0 |  |
| geth-case-002 | workflow | yes | 0.075 | 0.000 | 0.000 | 1 | candidate_json_sidecar | 0 |  |
| geth-case-004 | plain | yes | 1.000 | 1.000 | 1.000 | 0 | json_block | 0 |  |
| geth-case-004 | self-check | yes | 1.000 | 1.000 | 1.000 | 0 | json_block | 0 |  |
| geth-case-004 | workflow | yes | 1.000 | 1.000 | 1.000 | 0 | candidate_json_sidecar | 0 |  |
| geth-control-001 | plain | yes | 1.000 | 1.000 | 1.000 | 0 | json_block | 0 |  |
| geth-control-001 | self-check | yes | 1.000 | 1.000 | 1.000 | 0 | json_block | 0 |  |
| geth-control-001 | workflow | yes | 1.000 | 1.000 | 1.000 | 0 | candidate_json_sidecar | 0 |  |
| geth-control-002 | plain | yes | 1.000 | 1.000 | 1.000 | 0 | json_block | 0 |  |
| geth-control-002 | self-check | yes | 1.000 | 1.000 | 1.000 | 0 | json_block | 0 |  |
| geth-control-002 | workflow | yes | 1.000 | 1.000 | 1.000 | 0 | candidate_json_sidecar | 0 |  |
