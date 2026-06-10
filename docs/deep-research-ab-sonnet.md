# Deep Research A/B 비교: pi-workflow vs Claude Code (sonnet, thinking low)

작성일: 2026-06-09
모델: 양쪽 모두 `claude-sonnet-4-6`, reasoning/effort = low
주제(양쪽 동일): "2025-2026년 Claude(Anthropic)와 OpenAI의 프롬프트 캐싱 전략 비교 — cache breakpoints/cache_control, TTL, write 대 read 가격, prefix 안정성, 코딩 에이전트를 위한 구체적 가이드, 출처 인용 포함."

## 한눈에 보기 (TL;DR)

- 같은 주제, 같은 모델, 같은 reasoning 레벨. 양쪽 모두 plan → search → fetch → verify → synthesize 전체 deep research를 출처 인용과 함께 완료.
- **Claude Code: 약 4.9분, 32 agents, 871,815 토큰, tool 호출 105회.**
- **우리 pi-workflow: 약 7.4분, 25 tasks, 토큰 미집계(OAuth sonnet 경로), valid 구조화 JSON 보고서.**
- 양쪽 모두 핵심 결론은 동일하게 도달. 단, **사실관계 충돌 1건** 발생: 우리 보고서는 "두 벤더 모두 캐시 read 약 90% 할인"이라 했고, Claude 보고서는 "OpenAI는 50%"라고 함. 문서상 더 정확한 값은 OpenAI 50%이므로, 이건 단순 스타일 차이가 아니라 실측 품질 신호.
- 구조는 거의 동형. 차이점: 우리는 검증(verify)을 더 두텁게 fan-out(16개), Claude는 수집(search/fetch)을 더 두텁게 fan-out(10+14개).

## 실행 메타데이터

| 항목 | 우리 pi-workflow | Claude Code |
|---|---|---|
| 구동 방식 | 고정 recipe `deep-research-sonnet-low.json` | 모델이 즉석 생성한 JS workflow |
| 모델 | claude-sonnet-4-6, thinking low | claude-sonnet-4-6, effort low |
| 상태 | completed | completed |
| wall-clock | 446초 (~7.4분) | 291초 (~4.9분) |
| 실행 단위 | 25 tasks | 32 agents |
| 총 토큰 | 미집계 (아래 주석 참고) | 871,815 |
| tool 호출 | 미집계 | 105 |
| 단계 | plan → research-questions → normalize-claims → verify-claims → final | Plan → Search → Fetch → Verify → Synthesize |

토큰 주석: 직전 Kimi A/B에서는 우리 엔진이 task별 정확한 usage를 기록했음. 이번에는 subagent가 Anthropic OAuth(구독) sonnet 경로로 돌았는데, 이 경로에서는 pi가 `result.json`의 `usage`를 채우지 않음(전부 0/null). 따라서 이번 실행에서는 토큰 비용 비교가 불가하며, 이는 엔진 한계가 아니라 provider/auth 아티팩트임(Kimi 실행에서는 정상 집계됨).

## 단계 / fan-out 형태

| 단계 | 우리 | Claude |
|---|---|---|
| 계획 | plan ×1 | Plan ×1 |
| 검색 / 질문 fan-out | research-questions ×6 | Search ×10 |
| 출처 fetch | (research에 통합) | Fetch ×14 |
| 검증 | verify-claims ×16 | Verify ×6 |
| 종합 | final ×1 | Synthesize ×1 |
| 합계 | 25 | 32 |

해석: 양쪽 모두 동일한 표준 deep-research 그래프. 우리는 검증에 비중을 둠(verify 16개), Claude는 수집에 비중을 둠(search 10 + fetch 14). Claude의 더 두터운 fetch가 토큰 수가 많은 이유이자 가격 수치가 더 정확한 이유로 보임.

## 산출물 — 실제로 뭐가 다른가

### 우리 최종 보고서 (`structuredOutput`)

최상위 키: `finalReport`, `claimVerdictIndex`.

`finalReport` 키(10개): `summary`, `coverageSummary`, `mainFindings`, `caveatedFindings`, `contestedAreas`, `notableUnsupportedClaims`, `researchScopeCoverage`, `remainingGaps`, `recommendations`, `actionPlan`.

특징:
- finding이 `id`, `finding`, `claimIds`, `citations`를 가진 객체 → 각 finding을 검증된 claim ID로 역추적 가능.
- `recommendations`와 `actionPlan`이 1급 배열이며 `claimIds` + `priority`/`rationale` 포함.
- `claimVerdictIndex`가 종합 결과를 verify 단계와 연결.
- JSON 계약 검증 통과(`outputValidation: valid`).
- 성향: 실행 지향. "무엇을 할지"(순서 점검, 1,024 토큰 prefix 넘기기, breakpoint 4개 모두 쓰기)와 claim 추적성이 강함. 이번 실행에서 `caveatedFindings`, `contestedAreas`, `notableUnsupportedClaims`는 거의 비어 있었음.

### Claude 최종 결과 (`result`)

키(6개): `summary`, `findings`, `sources`, `caveats`, `actionable_guidance`, `metadata`.

특징:
- finding이 `topic`, `detail`, `sources`를 가진 객체 → 주제 영역별로 정리, 각각 산문 설명 + 출처 URL.
- `sources`가 별도 리스트(11개)이며 각 항목에 `url`, `title`, `credibility`(출처별 신뢰도 등급) 포함.
- `actionable_guidance`는 8개 가이드 문자열의 평평한 리스트.
- `metadata`: `{ queries_run: 10, sources_searched: 30, sources_fetched: 14, claims_verified: 6 }` — 결과에 실행 telemetry 내장.
- 성향: 리포트 지향. 정량 비교 표(가격 배수, TTL, 최소 토큰 임계값)와 출처별 신뢰도 명시가 강함.

### 나란히 비교

| 관점 | 우리 | Claude |
|---|---|---|
| 결과 컨테이너 | `finalReport` + `claimVerdictIndex` | 평평한 `result` |
| finding 단위 | `{id, finding, claimIds, citations}` | `{topic, detail, sources}` |
| 추적성 | claim ID로 finding → verify 단계 연결 | finding별 출처 URL |
| 출처 | finding 안에 인라인 인용 | 전용 `sources[]` + 신뢰도 등급 |
| 가이드 | `recommendations` + `actionPlan` (claimIds, priority 포함) | `actionable_guidance[]` (평평한 문자열) |
| 결과 내 실행 telemetry | 없음 (run.json/tasks에 존재) | 있음 (`metadata` 블록) |
| 어조 | 실행 계획 | 표 중심 분석 리포트 |

## 내용 검증 (결론이 일치했나?)

양쪽 모두 독립적으로 다음 결론:
- Claude = 명시적 `cache_control` breakpoint, 최대 4개, tools → system → messages 순서 강제, read 90% 할인, write 프리미엄(5분 1.25×, 1시간 2×), 5분 TTL(히트 시 갱신).
- OpenAI = 자동 prefix 캐싱, 마커 없음, 최소 1,024 토큰, write 추가 비용 없음, 약 1시간 TTL.

주목할 충돌:
- 캐시 read 할인율. 우리: "두 벤더 모두 캐시 read 약 90% 할인." Claude: "Claude 90% read 할인, OpenAI는 50%." OpenAI 50%가 더 잘 문서화된 값. 이번 실행에서 Claude의 더 두터운 1차 문서 fetch/verify가 더 정확한 가격 분리를 만들어냄. 우리 실행은 90%를 두 벤더에 과일반화함. 단발 실행 기준의 구체적이고 검증 가능한 품질 차이.

## 해석

- 속도: 이번엔 Claude가 더 빠름(4.9분 vs 7.4분). 수집을 더 병렬화.
- Telemetry: Claude는 토큰/tool 수를 완전히 보고. 우리 실행은 OAuth sonnet usage 보고 공백 때문에 미보고(Kimi 실행에서는 보고됨).
- 품질: 깊이는 비슷. Claude 출력이 가격(50% 포인트)에서 약간 더 정확하고 출처별 신뢰도를 제공. 우리는 claim→finding 추적성이 강하고 실행 지향적.
- 구조: 양쪽 모두 동일한 deep-research 골격. 차이는 fan-out 예산을 어디에 쓰느냐.

## 한계 / 공정성

- 각 1회 실행이라 ±20%는 노이즈로 봐야 함.
- 우리 recipe는 고정·결정론적; Claude는 매번 workflow script를 재생성하므로 형태가 실행마다 달라질 수 있음.
- 이번 실행에서는 토큰 비용 비교 불가(우리 쪽 OAuth usage 공백). 직전 Kimi A/B와 다른 점.
- 두 `workflow` tool은 동시에 로드하지 않음(둘 다 `workflow` tool을 등록하므로 충돌). 각자 별도 프로세스에서 실행.

## raw 산출물과 읽는 법

우리 (pi-workflow):
- run 디렉토리: `.pi/workflows/workflow_mq6p8tac_6b0ebb/`
- run 레코드(상태/tasks/stages): `.pi/workflows/workflow_mq6p8tac_6b0ebb/run.json`
- 최종 종합 보고서: `.pi/workflows/workflow_mq6p8tac_6b0ebb/tasks/task-5/result.json`
  - 구조화 보고서 본문은 `.structuredOutput.finalReport` 아래
- 단계별 task 결과: `.pi/workflows/workflow_mq6p8tac_6b0ebb/tasks/task-*/result.json` 및 `output.log`
- 사용한 recipe: `workflows/deep-research-sonnet-low.json` (`workflows/deep-research.json`의 sonnet:low 변형)
- 최종 결과 백업: `/tmp/dr-ab/RESULT-ours-final.json`

Claude Code:
- run 요약(메타 + result + progress, 단일 파일): `~/.claude/projects/-Users-toby-pi-pi-subagent-flow/40ac273c-ae7a-4bd8-93de-944dddaecd44/workflows/wf_28628298-66b.json`
  - 최종 보고서는 `.result` 아래
  - agent별 telemetry는 `.workflowProgress[]` 아래
- 생성된 workflow JS: `~/.claude/projects/-Users-toby-pi-pi-subagent-flow/40ac273c-ae7a-4bd8-93de-944dddaecd44/workflows/scripts/prompt-caching-deep-research-wf_28628298-66b.js`
- subagent별 세션/journal: `~/.claude/projects/-Users-toby-pi-pi-subagent-flow/40ac273c-ae7a-4bd8-93de-944dddaecd44/subagents/workflows/wf_28628298-66b/`
- run json 백업: `/tmp/dr-ab/RESULT-claude-run.json`

공통 스크래치 / 입력:
- 주제 프롬프트: `/tmp/dr-ab/topic.txt`
- Claude 프롬프트: `/tmp/dr-ab/claude-prompt.txt`
- 우리 러너: `/tmp/dr-ab/run-ours.mjs`
- 로그: `/tmp/dr-ab/logs/` (`ours.{out,err}`, `claude.{out,err}`)
