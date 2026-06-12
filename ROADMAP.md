# pi-workflow Roadmap

Updated: 2026-06-12. (이전 ROADMAP.md는 복구 과정에서 유실됨 — 현재 미정식 항목부터 다시 기록한다.)

## 정식 레이어 모델

공개 워크플로 정의는 세 레이어를 분리한다.

- 워크플로 레이어: `id`, `from`, `sourcePolicy`, 스케줄링, run artifact.
- 서브에이전트 레이어: `task` / `foreach` / `reduce` / `loop` / `parallel` — 자식 Pi 프로세스와 모델 호출.
- 지원(support) 레이어: `support: { uses: "./helpers/name.mjs", options?: {...} }` — 번들 로컬 `.mjs` helper 실행. 서브에이전트 task type이 아니며 sandbox가 아니다.

레거시 `type: "transform"` 문법은 비공식 표면이었고 이제 migration error로 거부한다. helper ref는 `support.uses`, 옵션은 `support.options`로 옮긴다.

## 미정식 기능 (스펙 표면에 노출되어 있으나 정식 아님)

### 1. `flow: { type: "dag" }` 바디 — 스키마만 있고 컴파일 안 됨

현재 상태: **비공식 + 깨짐**. 스키마는 `type: "dag"` + 태스크별 `dependsOn`을 통과시키지만 (`schema.ts:227`), 컴파일러 `getWorkflowTasks`가 single/parallel/chain만 처리해서 dag 바디는 `spec.flow.steps`(undefined) 경로로 떨어져 TypeError 크래시 (`compiler.ts:151`).

- [ ] 둘 중 하나로 해소:
  - (a) 스키마에서 dag 바디를 명시적으로 거부하고 스테이지 포맷의 `from` 배선을 안내, 또는
  - (b) `getWorkflowTasks`에 dag 지원을 추가해 task-list 형태의 명시적 DAG를 정식화
- 참고: DAG 토폴로지의 **지원되는 유일한 경로**는 스테이지 포맷의 `from` 배선 (배열 fan-in 포함, 실행은 `scheduleDag`). 다이아몬드 예시는 docs/usage.md 참조 대상.
- 관련 갭: `from`은 의존성과 데이터를 함께 끌어오므로 "데이터 없이 순서만 거는" 순수 순서 엣지는 표현 불가 — (b)를 택하면 함께 해소됨.

## 완료 (참고)

- 2026-06-12: `/workflow resume`(완료 태스크 보존 리셋), 세션 시작 시 미완 run 노티, `pi-workflow supervise` standalone 수퍼바이저 + `/workflow run --detach` (804d415, b206e44)
