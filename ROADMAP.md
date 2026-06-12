# pi-workflow Roadmap

Updated: 2026-06-12. (이전 ROADMAP.md는 복구 과정에서 유실됨 — 현재 미정식 항목부터 다시 기록한다.)

## 미정식 기능 (스펙 표면에 노출되어 있으나 정식 아님)

### 1. `transform` 스테이지 — 정식화 전에 레이어 분리 필요

도입: 6e1ac22 (2026-06-10, deep-research 번들 마이그레이션과 함께). 현재 상태는 **비공식**.

문제: 스테이지 목록이 두 개의 서로 다른 실행 레이어를 같은 평면에 섞고 있다.

- 서브에이전트 레이어: `task` / `foreach` / `reduce` / `loop` / `parallel` — 자식 Pi 프로세스, 모델 호출, 출력 계약·재시도·interrupt 의미론 보유
- 코드 레이어: `transform` — 로컬 `.mjs` helper, 모델 호출 없음, 결정론적

정식화 전 필요한 분리 작업:

- [ ] 실행 계층을 타입/계약 수준에서 분리 (서브에이전트 스테이지와 코드 스테이지의 공통 인터페이스 + 각자 의미론 명시)
- [ ] 코드 레이어의 에러·재시도·resume 의미론 정의 (현재 resume(W-2)은 서브에이전트 태스크 기준으로 설계됨; transform 실패/리셋 경로 검증 안 됨)
- [ ] 보안 경계 문서화 (helper path containment은 있음 — 그 외 실행 제약: 네트워크? fs 범위?)
- [ ] 스케줄러/관측 경로 분리 표시 (status·logs에서 코드 스테이지임이 드러나야 함)

분리 전까지: deep-research 번들 내부 사용에 한정. 신규 워크플로에서 사용 비권장.

### 2. `flow: { type: "dag" }` 바디 — 스키마만 있고 컴파일 안 됨

현재 상태: **비공식 + 깨짐**. 스키마는 `type: "dag"` + 태스크별 `dependsOn`을 통과시키지만 (`schema.ts:227`), 컴파일러 `getWorkflowTasks`가 single/parallel/chain만 처리해서 dag 바디는 `spec.flow.steps`(undefined) 경로로 떨어져 TypeError 크래시 (`compiler.ts:151`).

- [ ] 둘 중 하나로 해소:
  - (a) 스키마에서 dag 바디를 명시적으로 거부하고 스테이지 포맷의 `from` 배선을 안내, 또는
  - (b) `getWorkflowTasks`에 dag 지원을 추가해 task-list 형태의 명시적 DAG를 정식화
- 참고: DAG 토폴로지의 **지원되는 유일한 경로**는 스테이지 포맷의 `from` 배선 (배열 fan-in 포함, 실행은 `scheduleDag`). 다이아몬드 예시는 docs/usage.md 참조 대상.
- 관련 갭: `from`은 의존성과 데이터를 함께 끌어오므로 "데이터 없이 순서만 거는" 순수 순서 엣지는 표현 불가 — (b)를 택하면 함께 해소됨.

## 완료 (참고)

- 2026-06-12: `/workflow resume`(완료 태스크 보존 리셋), 세션 시작 시 미완 run 노티, `pi-workflow supervise` standalone 수퍼바이저 + `/workflow run --detach` (804d415, b206e44)
