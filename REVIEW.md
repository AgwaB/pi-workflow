# 코드 리뷰 — `pi-subagent-flow`

- **대상 커밋**: `d73db04` (`main`)
- **리뷰 일자**: 2026-05-31
- **방법**: 격리된 git worktree(`review/code-review-2026-05-31`)에서 8개 차원별 리뷰어가 코드를 읽고, **각 발견을 독립 회의주의 검증자가 실제 코드와 대조해 반증 시도** (find → adversarial verify).
- **결과**: 원시 35건 → **확인 25건 / 반증·무효 10건**. 검증 단계에서 High 후보 다수가 Low로 강등됨.
- **베이스라인**: `tsc --noEmit` 통과, unit test **47/47 통과** (리뷰 시작 시점).

## 한 줄 결론

견고하게 만들어진 MVP. 가장 어려운 부분(파일 락/리스, bash 러너 생성)은 검증에서 "그럴듯한 버그" 10건이 실제로는 방어되고 있음이 입증됨. **즉시 머지를 막을 blocker 없음.** Critical/High 0건, 실질 수정 가치가 있는 건 **Medium 2 + Low 10**, 나머지는 정리성 nit.

---

## 레포 개요

Pi 코딩 에이전트용 확장. JSON/YAML "flow spec" → 검증/컴파일(`schema.ts`/`compiler.ts`) → 각 task를 tmux pane 안의 자식 `pi` 프로세스로 실행(`tmux.ts`) → 디스크 아티팩트(`.pi/flows/<run-id>/`)에서 결과 재조정(`engine.ts`/`store.ts`).

- 10가지 flow 타입: single / parallel / chain / dag / map / route / partition / retry / until-pass / tree
- 설계 철학: **명시적 spec 전용**, 부모 소유 스케줄링, 자식 위임 금지, fail-closed 검증, mutation 작업은 managed worktree 격리
- 규모: ~4,700 LOC, 13개 src 파일

---

## 확인된 이슈

### 🟠 Medium

#### M1 · until-pass가 통과해도 "failed"로 (영구) 기록될 수 있음
- **위치**: `engine.ts` (refreshRun: `refreshRunFromArtifacts` → `applyFlowPostRefresh` 순서, 52-59 / 330-336), `store.ts:522-528` (`deriveUntilPassFlowStatus`), `tmux.ts:138`
- **내용**: `refreshRunFromArtifacts`가 check 완료를 `statusDetail="completed"`로 기록하고 `writeRunRecord`(tmux.ts:138)를 **먼저** 호출. 이 시점엔 아직 `until_pass_passed`가 안 붙어서 `deriveUntilPassFlowStatus`가 마지막 `return "failed"` 폴스루로 떨어짐 → run.json/index.json에 일시적으로 `"failed"`가 기록됨. 직후 `markUntilPassChecks`가 `until_pass_passed`를 박고 `"completed"`로 교정.
- **영향**:
  - 통과한 **모든** until-pass run마다 순간적으로 `"failed"`가 디스크에 노출(다른 프로세스가 sub-ms 윈도우에 읽을 수 있음).
  - 두 write 사이에 프로세스가 죽으면(crash/OOM/전원) `"failed"`가 **영구화**. `resumeSupervisors`는 `running`만 재스케줄(engine.ts:88), `scheduleRun`은 terminal에서 조기 return(engine.ts:126) → **자동 복구 안 됨**. 사용자가 `/flow show|status|wait`를 다시 칠 때만 교정됨.
- **심각도 근거**: 메커니즘 확실하나 영구화는 (정밀 타이밍 crash + 마지막 check + 아무도 재조회 안 함) 조건이라 확률 낮음 → Medium.
- **수정 방향**: check 완료 순간(`refreshRunFromArtifacts`/`applyTerminalResult`)에 PASS/FAIL를 분류해 `until_pass_passed`를 바로 세팅하거나, `resumeSupervisors`가 시작 시 terminal until-pass run에 대해 1회 `applyFlowPostRefresh`를 돌리기. (engine/tmux 모듈 경계를 건드리는 설계 수정 → 자동 적용보다 논의 권장)

#### M2 · YAML: `]`/`}`로 끝나는 일반 문자열이 inline collection으로 강제 라우팅돼 거부/오파싱
- **위치**: `yaml.ts:275-276`
- **내용**:
  ```ts
  if (value.startsWith("[") || value.endsWith("]")) return parseInlineArray(value, line);
  if (value.startsWith("{") || value.endsWith("}")) return parseInlineObject(value, line);
  ```
  `||` 때문에 `]`(또는 `}`)로 **끝나기만** 해도 inline 파서로 감. `parseInlineArray`는 `[`로 시작하지 않으면 즉시 `invalid inline array` 예외.
  - `task: Fix the bug in ticket [ABC-12]` → 예외 (false-reject)
  - `pattern: [0-9]` → 조용히 `["0-9"]` 배열로 **오파싱** (더 위험)
  - `task`/`description`/`prompt`/`role`은 자유 텍스트 필드라 흔히 터짐. README:83 "plain scalars … work" 계약 위반.
- **심각도 근거**: JSON이 canonical이고, 대부분 spec-load/validate 시점에 에러로 드러나 라이브 flow 손상은 드묾 → Medium(원래 High에서 강등).
- **수정(1줄 권장)**: `endsWith` 가지를 제거하고 `value.startsWith("[")`/`value.startsWith("{")`만 검사.
  - `foo]` → 평범한 문자열로 처리(정상)
  - `[a, b`(미완성) → 여전히 `parseInlineArray`가 닫힘 괄호 없음으로 fail-closed 예외(검증자 제안 `&&`보다 이 방식이 fail-closed를 더 잘 보존)

### 🟡 Low

| ID | 위치 | 내용 | 비고 |
|---|---|---|---|
| **L1** | `store.ts:176/183/185` + `README:421` | 락 mtime이 5분(`LEASE_FORCE_STALE_MS`) 초과면 **owner PID가 살아있어도** force-reclaim. README는 "owner process가 죽었을 때만 회수"로 명시 → 문서/동작 불일치. 매 write의 `assertLockOwner`가 폐위된 supervisor를 fail-fast시켜 데이터 손상은 차단됨. | docs 교정으로도 해소 |
| **L2** | `tmux.ts:83, 125-135, 303-311` | **죽은 코드**: `statusDetail === "pane_created"` 분기 도달 불가(launch는 `"launching"→"running"`만 세팅). `command_not_started` 조기 감지가 영영 안 돎. `fileExists()`·`outputFile` 바인딩도 이 분기 전용 고아. | 삭제 권장 |
| **L3** | `compiler.ts:105, 666-673, 697-705` | `readOnly:true` + `bash`가 모순 에러 없이 컴파일(`EXPLICIT_WRITE_TOOLS`만 검사). `readOnlyDeclared=true`인데 `capability=mutation-capable` 내부 불일치. worktree 격리+문서로 영향 제한. | 일관성 개선 |
| **L4** | `engine.ts:196, 738` | 상태 요약 줄에 `skipped` 카운트 누락 → chain 실패 후 per-status 합이 total과 안 맞아 보임(표시 갭, 상태 자체는 정상). | 1토큰 수정 |
| **L5** | `tmux.ts:250-259, 70-76` | `createTmuxPane`가 `split-window` 성공 후 `display-message`에서 throw하면 pane은 살아있는데 `paneId` 미기록 → 추적 불가 고아 자식. `paneId`를 split 직후 먼저 저장하면 해결. | 드묾 |
| **L6** | `tmux.ts:323-328` | result `completedAt`이 파싱 불가일 때 wall-clock `now()` 기준 timeout으로 오판 → 정상 완료가 `failed/timeout`(exit 124)로. 깨진 result.json 필요. `applyTerminalResult`(345)는 이미 올바르게 `nowIso()` 대체. | |
| **L7** | `compiler.ts:158-167, 263-273` | `validateProgrammaticBounds`가 until-pass `maxIterations`는 재검증하나 retry `maxAttempts`는 안 함(비대칭). public 경로는 schema가 막아 안전, `compileFlowSpec` 직접 호출 시만 노출. | fail-closed 일관성 |
| **L8** | `compiler.ts:319-326, 78-82` | until-pass의 work/check에 같은 explicit id를 주면 합성 id 충돌로 "duplicate task id" 거부. id는 실행에 안 쓰이는데 멀쩡한 spec을 거부(fail-closed지만 불필요). 합성 id에 role/kind를 넣으면 해소. | |
| **L9** | `schema.ts:561` / `compiler.ts:787` | `jsonKey()` 동일 정의 2벌 → 드리프트 위험(에러 경로 포맷용). | 1곳 export 후 import |
| **L10** | `schema.ts:29` / `compiler.ts:33` | iteration cap `5`가 `MAX_LOOP_ITERATIONS` / `MAX_UNTIL_PASS_ITERATIONS` 두 상수로 중복. | 공유 상수화 |

### ⚪ Nit

| ID | 위치 | 내용 |
|---|---|---|
| **N1** | `tmux.ts:164` | JSON 이벤트 프리필터가 공백 민감(`"type":"message_end"` 정확 매칭). Pi가 pretty/공백 JSON을 내보내면 전체 출력 유실 → `no_final_output` 오분류. 정규식 `/"type"\s*:\s*"(message_end\|agent_end)"/`로 완화 권장. |
| **N2** | `compiler.ts:112, 616-619, 641` | `filterDelegationTools`와 line-112 재검사는 실질 도달 불가한 defense-in-depth(이미 거부됨). 주석 명시 또는 제거. |
| **N3** | `compiler.ts:78-81` | 중복 id 에러가 충돌을 일으킨 필드가 아닌 현재 엔트리 경로를 가리켜 오안내(예: id 없는 `steps[1]`을 `$.flow.steps[1].id`로 지목). |
| **N4** | `yaml.ts:281` | 정수 강제변환이 leading zero(`0700`→700)·big-int 정밀도 손실. 모든 숫자 schema 필드가 bounded라 다운스트림 fail-closed → 실영향 거의 없음(FP 위험 높음). |
| **N5** | `schema.ts:290-302` | `parseMapItems`와 `parsePartitionItems`가 바이트 동일(각 1회 호출). 단일 헬퍼로 통합. |
| **N6** | `engine.ts:771` / `store.ts:538` | `sleep()` 중복. store에서 export 후 engine이 import. |
| **N7** | `README:383` | on-request 차단 설명이 mutation-capable만 언급하나 실제론 write-capable(edit/write)도 차단(`compiler.ts:697` `capability !== "read-only"`). |
| **N8** | `compiler.ts:423-427` | "unused route" 거부 규칙이 README에 미문서화(README:193은 forward 방향만 기술). |

---

## 견고함이 입증된 부분 (반증된 10건)

검증 단계가 다음 "그럴듯한 버그"들을 코드/실측으로 반증함 — 코드베이스의 강점:

- **락 TOCTOU 이중획득** — `open(lockFile, "wx")` 원자성이 막음. 한쪽만 승리, 패자는 EEXIST.
- **tee process-substitution stderr 레이스** — bash 5.x가 procsub 자식을 다음 명령 전에 reap (300+회 실측, truncation 0건). `#!/usr/bin/env bash` shebang으로 보장.
- **deposed supervisor가 run.json 계속 변조** — 매 write의 `assertActiveRunLease` → `assertLockOwner`가 fail-fast.
- **createTmuxPane이 죽은 pane에 throw** — tmux는 죽은/없는 pane 조회 시 exit 0 반환(throw 아님) → `pid: undefined`로 graceful 처리.
- **index/run.json 원자성** — `rename(2)`로 reader는 torn 상태 못 봄. 스테일 인덱스는 `formatStatus`의 reconcile 경로가 self-heal(README:422에 by-design 명시).
- **writeJsonAtomic temp 충돌 / fsync 미보장** — ms 타임스탬프+`randomBytes(3)`로 충돌 사실상 불가, 캐시 graceful degrade로 by-design.
- **watchRun 타이머 틱 중첩** — 같은 프로세스 내 두 번째 틱은 `wx` 락 실패로 no-op.

추가로 fail-closed 검증(unknown key 거부, 배열 상한, DAG/tree 사이클·중복 검출), 경로/심링크 봉쇄(`agents.ts` realpath 검사), prototype-pollution 가드(yaml·frontmatter), launch-token 위조 방지 등 보안 기본기가 탄탄.

---

## 권장 조치

1. **즉시(저위험·고확신)**: M2(1줄) · L4(1토큰) · L2/L9/L10/N5/N6(죽은코드·중복 정리) — worktree에서 바로 적용 + `tsc`/test 검증 가능.
2. **설계/문서 결정 필요**: M1(상태 도출 순서) · L1(README 한 문장 교정만으로도 해소) · L3(readOnly 일관성).
3. **백로그**: 나머지 Low/Nit.

> `judge`/`vote`/critic 출력과 마찬가지로, 이 리뷰의 발견도 근거 확인 후 적용을 권장합니다. 각 항목에 file:line·트리거·결과를 명시했으니 수정 전 해당 위치를 직접 확인하세요.
