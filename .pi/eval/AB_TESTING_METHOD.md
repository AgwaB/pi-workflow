# A/B 테스트 방식 정리

> 로컬 pi-workflow / deep-review 평가용 운영 문서. 공개 문서가 아니라 `.pi/eval/` 아래에 두는 실험/운영 기준이다.

## 1. 목적

A/B 테스트의 목적은 “어떤 모델이 더 똑똑한가”가 아니라, **같은 모델을 고정했을 때 workflow orchestration이 plain review보다 실제 코드리뷰 결함 발견에 도움이 되는지**를 측정하는 것이다.

핵심 질문:

1. 같은 모델/같은 thinking에서 `workflow`가 `plain`보다 recall을 올리는가?
2. recall을 올리더라도 false positive나 invalid output을 과하게 늘리지 않는가?
3. 쉬운 task가 아니라 plain baseline이 놓치는 hard task에서 workflow 이점이 있는가?
4. 결과가 LLM judge 취향이 아니라 deterministic artifact/gold-key scoring으로 설명되는가?

## 2. 현재 권장 비교 방식

현재 주 비교 대상은 bug-forge 기반 seeded code-review benchmark다.

```text
.pi/eval/bug-forge/
```

권장 모델:

```text
openai-codex/gpt-5.5
```

주의:

- `openai/gpt-5.5`는 quota 문제를 냈으므로 현재는 `openai-codex/gpt-5.5`를 사용한다.
- 예전 문서/러너에는 Kimi 기준 예제가 남아 있다. 비교는 항상 **한 run 안에서 모델을 고정**해야 한다.

## 3. Arms

기본 3-arm 비교:

| Arm | 의미 | 목적 |
|---|---|---|
| `plain` | 단일 모델이 후보 diff를 직접 리뷰 | 최저 orchestration baseline |
| `self-check` | plain 결과를 같은 모델이 한 번 더 검토/수정 | cheap reflection baseline |
| `workflow` | deep-review workflow fanout/reduce/partition/report | orchestration 효과 측정 |

해석 원칙:

- provider/model을 바꾸면 A/B가 아니라 model comparison이 된다.
- `workflow` arm은 run-local workflow variant에 model/thinking을 pin해야 한다.
- fast mode에서는 최종 report stage 없이 partition 결과만 채점할 수 있으나, 이 경우 precision/dedup 성능이 full mode와 다를 수 있다.

## 4. Task 구조

bug-forge task는 PR-like fixture다.

```text
tasks/<candidate-id>/
├── task.json                # 메타데이터. candidateVisible만 후보에게 안전
├── fixture.diff             # 후보가 리뷰할 proposed patch
├── gold-key.draft.json      # private oracle. 후보에게 절대 노출 금지
├── reference-fix.patch      # private reference fix. 후보에게 절대 노출 금지
├── repro.sh                 # maintainer-only RED/GREEN check
└── author-notes.md          # private notes. 후보에게 절대 노출 금지
```

좋은 task 조건:

- source revision이 고정되어 있다.
- fixture diff가 작고 리뷰 가능한 크기다.
- deterministic repro가 있다.
- source-only reverse fixture라면 fixed commit + regression test 조합으로 RED/GREEN이 선명하다.
- plain baseline이 항상 1.0을 찍지 않는 hard case가 포함되어 있다.
- no-issue control도 일부 포함한다.

나쁜 task 신호:

- 모든 arm이 0.9 이상: smoke/regression용이지 discriminator가 아니다.
- 모든 arm이 0.2 이하: gold가 모호하거나 task가 과하게 어렵다.
- build failure만 유발: code-review benchmark로는 약하다.
- gold evidence가 지나치게 좁아 실제 true positive를 miss 처리한다.

## 5. Isolation / leakage 원칙

후보 arm은 다음만 볼 수 있다.

허용:

- sanitized repository snapshot
- proposed `fixture.diff`
- neutral review prompt
- 표준 로컬 tooling

금지:

- `.git/`과 git history
- `.pi/eval/` 전체
- `gold-key*.json`
- `reference-fix.patch`
- `repro.sh`
- prior run outputs
- judge prompts / score outputs / answer keys
- A/B arm labels
- task bucket, expected bug count, source PR/issue text

fail-closed 규칙:

- contamination을 배제할 수 없으면 invalid로 처리하고 새 workspace에서 재실행한다.
- invalid cell은 aggregate 해석에서 제외하거나 quarantine한다.
- output에 oracle/gold/scoring/A-B 근거를 사용한 흔적이 있으면 점수와 무관하게 invalid다.

## 6. Gold-key 작성/검토

Gold key는 live judge가 아니라 deterministic scoring의 기준이다.

권장 workflow:

1. maintainer가 fixture와 repro를 만든다.
2. provider 2개 이상이 독립적으로 gold를 검토한다.
3. disagreement가 있으면 `needs-review`로 유지하고 task를 rewrite/reject한다.
4. source-grounded claim만 gold에 넣는다.
5. locked 전 체크:
   - source revision pinned
   - fixture stable
   - every bug has concrete file/line/evidence
   - acceptable fixes are not over-specific
   - no-issue / must-avoid claims documented
   - leakage checklist passed

Provider review는 gold 품질을 높이는 보조 입력이다. scoring 시점의 live judge가 아니다.

## 7. Scoring 원칙

Primary score는 objective gold-key matching이다.

기본 매칭 조건:

- file/location이 gold accepted location과 맞는다.
- line/range가 겹치거나 symbol/evidence가 같은 root를 가리킨다.
- claim이 gold summary/impact와 의미적으로 맞는다.
- evidence quote가 후보-visible source/diff에 grounded되어 있다.

기본 metrics:

- severity-weighted precision
- severity-weighted recall
- F1
- evidence score
- false-positive count/weight
- no-issue hallucination penalty
- extraction mode
- invalid-cell reason

LLM judge는 readability/actionability를 보는 secondary audit일 뿐, factual correctness의 최종 판단이 아니다.

## 8. Fast mode vs Full mode

### Fast mode

목적: 빠른 pilot/smoke/variance check.

현재 옵션:

```bash
--workflow-no-report \
--allow-partition-only \
--workflow-score-stage partition
```

특징:

- workflow final report stage를 제거한다.
- partition output sidecar를 scoring한다.
- 실행 시간이 줄어든다.
- 단, final report의 dedup/root-merge가 빠지므로 FP가 늘거나 evidence 정리가 부족할 수 있다.

필수 조건:

- current worktree tracked-clean
- workflow extension root tracked-clean
- output root가 repo root/ancestor가 아님

### Full mode

목적: 최종 비교, precision/dedup 확인, publishable-ish internal result.

특징:

- final report/control artifact를 scoring한다.
- 느리지만 실제 workflow 사용 형태와 가깝다.
- fast mode에서 애매한 FP/miss가 보이면 full mode로 확인한다.

## 9. 표준 실행 절차

### 9.1 사전 검증

```bash
node .pi/eval/bug-forge/scripts/validate.mjs
```

특정 task repro:

```bash
bash .pi/eval/bug-forge/tasks/<task-id>/repro.sh
```

### 9.2 clean worktree 준비

Fast mode는 clean worktree guard가 있으므로 dirty root에서 직접 돌리지 않는다.

```bash
WT=/path/to/clean/eval-worktree
git worktree add --detach "$WT" HEAD
```

### 9.3 tmux에서 실행

긴 run은 tmux에서 실행한다.

예시: geth OSS pilot fast run

```bash
export BUG_FORGE_GETH_REPO=/tmp/pi-github-repos/ethereum/go-ethereum

node .pi/eval/bug-forge/scripts/calibrate.mjs \
  --tasks geth-case-001,geth-case-002,geth-case-003,geth-case-004,geth-case-005 \
  --arms plain,self-check,workflow \
  --model openai-codex/gpt-5.5 \
  --thinking low \
  --concurrency 2 \
  --pi-extension-root "$WT" \
  --workflow-extension-root "$WT" \
  --workflow-no-report \
  --allow-partition-only \
  --workflow-score-stage partition \
  --out .pi/eval/bug-forge/runs/<run-id>
```

외부 OSS repo task는 `sourceRepository`가 local git clone을 가리킨다. 예: `BUG_FORGE_GETH_REPO`.

## 10. Run artifact 구조

일반 run output:

```text
.pi/eval/bug-forge/runs/<run-id>/
├── manifest.json
├── summary.json
├── report.md
├── analysis.md                 # 사람이 작성한 해석 노트
├── tmux.log
├── run.sh
├── workflow-variants/
└── <task-id>/
    ├── plain/
    ├── self-check/
    └── workflow/
```

각 arm directory 주요 파일:

```text
materialize.json
prompt.md
output.md
output.candidate.json           # 가능한 경우 normalized findings sidecar
run-result.json
score.json
```

해석 시 우선순위:

1. `score.json`의 objective metrics
2. `invalidCell` 여부
3. `output.candidate.json` sidecar
4. raw `output.md`
5. 사람이 작성한 `analysis.md`

## 11. 결과 해석 규칙

### 11.1 Saturation

모든 arm이 0.9 이상이면 “workflow 승리”가 아니다.

해석:

- task가 너무 쉽다.
- smoke/regression bucket으로 내린다.
- harder variant를 찾아야 한다.

### 11.2 Workflow advantage

강한 workflow signal:

- plain/self-check recall 0 또는 낮음
- workflow recall 1
- workflow FP가 baseline보다 크게 늘지 않음
- output이 source/evidence에 grounded됨

예: `geth-case-002` pilot에서는 plain/self-check가 txpool race root를 놓쳤고 workflow가 잡았다.

### 11.3 Precision regression

workflow가 recall을 올리지만 FP도 늘면 다음을 확인한다.

- 같은 root를 source finding + test finding으로 중복 보고했는가?
- supporting evidence를 독립 bug로 잘못 승격했는가?
- low-confidence speculative claim을 keep했는가?

개선 방향:

- root-cause dedup 강화
- test-file finding은 source finding의 evidence로 흡수
- 같은 fix를 공유하는 finding merge

### 11.4 Gold/scorer mismatch

후보가 실제 bug를 찾았는데 score가 낮다면 즉시 workflow를 튜닝하지 않는다.

절차:

1. raw output과 gold evidence를 비교한다.
2. provider/gold review를 요청한다.
3. scorer/gold가 좁았는지 기록한다.
4. first-run raw score는 보존한다.
5. 필요하면 별도 “reviewed rescore” artifact를 만든다.

예: `geth-case-004` pilot에서 workflow는 nil-vs-empty JSON 문제를 찾았지만 raw scorer는 evidence/semantic-key mismatch로 miss 처리했다.

### 11.5 Invalid cells

다음은 정상 low score가 아니라 invalid/quarantine이다.

- model/API failure
- timeout or interrupted run
- missing workflow control artifact
- invalid JSON/extraction failure
- subagent failure
- contamination/leakage
- wrong provider/model alias
- runner bug

Invalid cell은 aggregate에서 승패 근거로 쓰지 않는다.

## 12. 개선 루프

권장 루프:

1. **Pilot**: 새 task를 소량 추가하고 one-pass run.
2. **Record**: raw outputs, scores, misses, invalids를 그대로 기록.
3. **Review**: gold/scorer mismatch와 ambiguous output을 provider/gold review.
4. **Freeze**: task/gold를 잠그거나 demote/rewrite.
5. **Repeat**: locked set에서 반복 run으로 variance 확인.
6. **Tune**: holdout first-run failure를 근거로 즉시 prompt를 고치지 말고, 별도 calibration set에서 개선 후 다시 측정.

금지:

- frozen holdout 결과를 보고 즉시 workflow prompt/helper를 튜닝하기
- invalid run을 낮은 성능으로 집계하기
- saturated task를 workflow superiority 근거로 사용하기
- LLM judge prose preference를 objective score보다 우선하기

## 13. 현재 geth pilot에서 배운 점

최근 fast run:

```text
.pi/eval/bug-forge/runs/geth-gpt55-codex-low-fast-20260617T115112Z/
```

Fast raw aggregate:

| Arm | Mean score | Mean recall | Mean precision | Total FP |
|---|---:|---:|---:|---:|
| plain | 0.587 | 0.600 | 0.600 | 2 |
| self-check | 0.696 | 0.800 | 0.667 | 3 |
| workflow | 0.780 | 0.800 | 0.733 | 2 |

Full workflow comparison run:

```text
.pi/eval/bug-forge/runs/geth-gpt55-codex-low-full-workflow-20260617T125846Z/
```

| Task | Fast workflow | Full workflow | Lesson |
|---|---:|---:|---|
| `geth-case-001` | 1.000 | 0.090 | Full report found the right root but lost the primary `waitForNodes` patch location. Treat as report/location preservation issue, not model miss. |
| `geth-case-002` | 1.000 | 1.000 | Stable workflow win over plain/self-check on race/lifecycle. |
| `geth-case-003` | 1.000 | 1.000 | Saturated/stable. |
| `geth-case-004` | 0.060 | 1.000 | Full report fixed the fast-mode scorer/gold evidence mismatch. |
| `geth-case-005` | 0.840 | 1.000 | Full report improved dedup/precision over partition-only fast mode. |

해석:

- plain GPT-5.5가 더 이상 완전 포화되지는 않는다.
- workflow는 `geth-case-002` 같은 race/lifecycle hard case에서 강한 장점이 있다.
- full report mode는 fast partition mode보다 precision/dedup/scorer compatibility가 대체로 좋다.
- 단, `geth-case-001`은 full report가 support/control-flow locations만 남기고 primary patch location을 누락하는 regression을 보였다.
- `geth-case-004` fast miss는 workflow recall 실패라기보다 gold/scorer evidence-key mismatch로 보인다.
- `geth-case-001`, `geth-case-003`은 smoke/regression 성격이 강하다.
- `geth-case-005`는 recall보다 precision/root-merge 확인용에 가깝다.

다음 우선순위:

1. `geth-case-004` gold/scorer/provider review.
2. `geth-case-001` full-report location preservation fix or reviewed scorer fallback.
3. root-cause dedup / support-location handling 개선.
4. geth에서 concurrency/race/state-machine 계열 hard task 추가.

## 14. 최소 보고 템플릿

새 A/B run을 보고할 때는 최소한 아래를 포함한다.

```markdown
# <run-id> A/B 결과

- Model:
- Thinking:
- Commit:
- Tasks:
- Arms:
- Mode: fast/full
- Runner command:
- Invalid cells:

## Aggregate

| Arm | Valid cells | Mean score | Mean recall | Mean precision | Total FP |
|---|---:|---:|---:|---:|---:|

## Per-task notes

- <task>: <plain/self-check/workflow 차이>

## Interpretation

- Strong signal:
- Saturated tasks:
- Gold/scorer review needed:
- Precision issues:

## Next actions

1.
2.
3.
```

## 15. 문서 위치 정책

- eval 운영 문서, runbook, analysis는 `.pi/eval/` 아래에 둔다.
- public `docs/`에는 사용자가 명시적으로 요청한 publishable summary만 둔다.
- raw runs는 기본적으로 commit하지 않는다.
- task/gold/scoring fixture처럼 재현에 필요한 compact artifact만 명시적으로 `git add -f` 한다.
