# Review A/B Evaluation — Broad Repo Reviews

This evaluation track compares `deep-review` against a plain single Pi run on broad repository review tasks. It is intentionally separate from `.pi/eval/ab-execution/` while the methodology is still evolving.

## Core idea

Broad reviews do not have a complete single ground truth. Use a hybrid oracle:

1. **Reference audit**: a precomputed, high-effort inventory of expected important risks/findings. This anchors recall.
2. **Finding-level verification**: candidate findings outside the reference can still receive credit if code evidence supports them.
3. **Noise accounting**: unsupported findings, nitpicks, and severity overstatements are penalized because they add reviewer burden.

The final winner should be computed from structured adjudication, not from a single subjective “which review is better?” judge call.

## Pipeline

```text
source repo + task definition
  -> reference audit generation (offline, hidden from candidate arms)
  -> candidate review A/B run (workflow:deep-review vs plain)
  -> finding extraction from each candidate output
  -> reference matching
  -> evidence verification against repository files
  -> scoring + report
```

## Artifact types

- `tasks.json`: broad review tasks and risk-area checklist.
- `references/*.json`: reference audits, hidden from candidate arms.
- `prompts/*.md`: prompts for reference generation, extraction, verification, and scoring.
- `runs/<timestamp>/`: future generated run reports.

## Initial target

Start with `pi-chat` because it is small enough for full-repo review but contains real security/product boundaries: chat input, secrets, attachments, Gondolin VM mounts, persistent memory/skills, and tmux workers.
