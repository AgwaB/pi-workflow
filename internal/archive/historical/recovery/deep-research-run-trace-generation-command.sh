> Historical archive. Non-authoritative. Preserved for recovery context only.
> Current public terminology is workflow / workflow spec / workflow file / workflow run.

python3 - <<'PY'
import json
from pathlib import Path

run_id = 'workworkflow_mq3d1nkq_ac6b53'
base = Path('.pi/workflows') / run_id
out = Path('docs/deep-research-run-trace-20260607.md')

workworkflow_run_path = Path('.pi/eval/ab-execution/runs/run-20260607T120050Z/internal/research-agent-evals/arm-a/workflow-run.json')
workworkflow_run = json.loads(workworkflow_run_path.read_text())

def read_text(p):
    return Path(p).read_text(errors='replace').strip()

def fenced_json(text):
    # preserve original, but use json fence for readability
    return '```json\n' + text + '\n```\n'

lines = []
lines.append('# deep-research 실제 실행 trace — question → claim → verify → final\n')
lines.append('이 문서는 실제 Kimi A/B 실행 artifact에서 `deep-research` workflow arm의 산출물을 단계 순서대로 묶은 것입니다.\n')
lines.append('- 대상 eval task: `research-agent-evals`\n')
lines.append('- eval run: `.pi/eval/ab-execution/runs/run-20260607T120050Z`\n')
lines.append(f'- workworkflow run: `{run_id}`\n')
lines.append('- 원칙: 한글 목차/설명만 추가하고, 각 산출물 JSON은 원본 파일 내용을 그대로 인용합니다.\n\n')

lines.append('## 0. 실행 구조 요약\n\n')
lines.append('```text\n')
lines.append('plan.main\n')
lines.append('  -> research-questions.item-001..007\n')
lines.append('  -> normalize-claims.main\n')
lines.append('  -> verify-claims.item-001..048\n')
lines.append('  -> final.main\n')
lines.append('```\n\n')
lines.append(f'- 총 task 수: {len(workworkflow_run.get("tasks", []))}\n')
for stage in ['plan','research-questions','normalize-claims','verify-claims','final']:
    count = sum(1 for t in workworkflow_run.get('tasks',[]) if t.get('stageId') == stage)
    lines.append(f'- `{stage}` tasks: {count}\n')
lines.append('\n')

# Plan
plan_path = base / 'stages/plan/tasks/main/output.log'
lines.append('## 1. Plan stage — research questions 생성 결과\n\n')
lines.append('아래는 질문을 어떻게 뽑았는지 보여주는 원본 `plan.main` JSON입니다.\n\n')
lines.append(f'- Source: `{plan_path}`\n\n')
lines.append(fenced_json(read_text(plan_path)))

# Research outputs
lines.append('## 2. Research questions stage — 각 question별 raw claims\n\n')
lines.append('아래는 각 research question을 독립 task로 조사한 결과입니다. 각 output 안의 `claims`가 normalize 전 raw claim입니다.\n\n')
research_tasks = [t for t in workworkflow_run.get('tasks',[]) if t.get('stageId') == 'research-questions']
for t in research_tasks:
    p = Path(t['files']['output'])
    lines.append(f'### 2.{len([x for x in lines if x.startswith("### 2.")])+1} `{t.get("id") or t.get("taskId")}`\n\n')
    lines.append(f'- Source: `{p}`\n\n')
    lines.append(fenced_json(read_text(p)))

# Normalize
norm_path = base / 'stages/normalize-claims/tasks/main/output.log'
lines.append('## 3. Normalize stage — raw claims → claimsForVerification\n\n')
lines.append('아래는 전체 raw claims를 dedupe/split/rank해서 검증 대상으로 고른 원본 JSON입니다. `claimsForVerification`가 verify stage로 넘어간 목록입니다.\n\n')
lines.append(f'- Source: `{norm_path}`\n\n')
lines.append(fenced_json(read_text(norm_path)))

# Verify outputs
lines.append('## 4. Verify stage — claim별 검증 결과\n\n')
lines.append('아래는 `claimsForVerification` 48개 각각에 대한 검증 task 원본 JSON입니다.\n\n')
verify_tasks = [t for t in workworkflow_run.get('tasks',[]) if t.get('stageId') == 'verify-claims']
for idx, t in enumerate(verify_tasks, 1):
    p = Path(t['files']['output'])
    lines.append(f'### 4.{idx} `{t.get("id") or t.get("taskId")}`\n\n')
    lines.append(f'- Source: `{p}`\n\n')
    lines.append(fenced_json(read_text(p)))

# Final
final_path = base / 'stages/final/tasks/main/output.log'
lines.append('## 5. Final stage — 최종 synthesis\n\n')
lines.append('아래는 verified/partially_supported claim들을 종합한 최종 output 원본 JSON입니다.\n\n')
lines.append(f'- Source: `{final_path}`\n\n')
lines.append(fenced_json(read_text(final_path)))

out.write_text(''.join(lines))
print(out)
PY
wc -l docs/deep-research-run-trace-20260607.md
