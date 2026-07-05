# [KICKOFF] 개선 작업 병렬 실행 — 서브에이전트 트랙 구성

> [`작업계획서-개선.md`](./작업계획서-개선.md)(이하 "개선계획")의 실행 문서.
> 실행 주체: **Opus 4.8 (medium effort) 서브에이전트**. 각 에이전트는 §4의 자기 트랙 프롬프트 하나만 받는다.
> 이 문서의 §1은 개선계획 §4 WBS의 병렬성 재검증 결과이며, 트랙 구성이 원 WBS 순서와 다른 경우 **이 문서가 우선**한다.

---

## 1. 병렬성 재검증 결과

### 1.1 파일 충돌 매트릭스 (재검증에서 발견된 수정사항)

개선계획 §4의 "M0~M2 병렬 가능" 표기는 **파일 소유권 기준으로 부정확**하다. 실제 접촉 파일:

| 작업                            | `svc-media/src/ingest.ts` | `svc-media/src/env.ts` | `svc-media` main/hls-server/retention | `web/components/broadcast.tsx` | `bff/src/ws/chat.ts` + `web/components/chat.tsx` |  infra/fly/compose  |
| ------------------------------- | :-----------------------: | :--------------------: | :-----------------------------------: | :----------------------------: | :----------------------------------------------: | :-----------------: |
| M1 레이트컨트롤                 |            ✏️             |           ✏️           |                   —                   |               —                |                        —                         |          —          |
| M2 코덱 협상 remux              |            ✏️             |           —            |                   —                   |               ✏️               |                        —                         |          —          |
| M4-3 인제스트 backpressure      |            ✏️             |           ✏️           |                   —                   |               —                |                        —                         |          —          |
| M3 MediaMTX 전환                |             —             |     ✏️(경로 변수)      |                  ✏️                   |               —                |                        —                         |         ✏️          |
| M4-1/2 팬아웃 backpressure·배칭 |             —             |           —            |                   —                   |               —                |                        ✏️                        |          —          |
| M0 베이스라인                   |             —             |           —            |                   —                   |               —                |                        —                         | — (docs/스크립트만) |

**결론**: `ingest.ts`를 M1·M2·M4-3 세 작업이 모두 수정 → 병렬 워크트리로 진행하면 3-way 충돌 확정.
→ **세 작업을 단일 에이전트(Track A)가 순차 수행**하도록 재편. 나머지는 상호 배타적.

### 1.2 확정 트랙 구성

| 트랙                     | 담당 작업 (개선계획 항목)                     | 소유 파일                                                                                                                        | 예상 규모 |
| ------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **T0 — 베이스라인**      | M0 전체                                       | `docs/perf-baseline.md`, `apps/svc-media/scripts/perf-*.ts`(신규)                                                                | ~2일      |
| **T-A — 인제스트**       | M1 → M2 → M4-3 (이 순서로 직렬)               | `apps/svc-media/src/ingest.ts`, `apps/svc-media/src/env.ts`, `apps/web/components/broadcast.tsx`, OBS 가이드 문서                | ~6일      |
| **T-B — 패키징(LL-HLS)** | M3-1(게이트) → M3-2~4. **M3-5는 통합 후(§5)** | `apps/svc-media/src/main.ts`·`hls-server.ts`·`retention.ts`, `infra/docker-compose.yml`, `fly.toml`(svc-media), `docs/DEPLOY.md` | ~7일      |
| **T-C — 팬아웃**         | M4-1 → M4-2 + k6 슬로우 클라이언트 시나리오   | `apps/bff/src/ws/chat.ts`, `apps/web/components/chat.tsx`, k6 스크립트                                                           | ~4일      |

- **공유 파일 단 하나**: `apps/svc-media/src/env.ts` (T-A가 변수 추가, T-B가 M3에서 경로 변수 조정 가능). → **T-A 먼저 머지, T-B가 rebase**로 해소. T-B는 env.ts 수정을 최소화한다.
- 병렬도: **T0 선행(짧음) 후 T-A ∥ T-B ∥ T-C 완전 병렬.**
- wall-clock: max(6d, 7d, 4d) ≈ **1.5주** (직렬 실행 ~3.5주 대비 절반 이하).
- 단, T-A·T-B·T-C의 **성능 게이트 판정(G1~G5)은 T0 산출물(베이스라인)에 의존** — 작업 착수는 T0와 병렬 가능하나, "완료" 선언은 T0 머지 후 통합 단계(§5)에서만 한다.

### 1.3 의존성 그래프

```
T0 (M0 베이스라인) ──────────────┐
                                 ▼
T-A (M1→M2→M4-3) ──┐        [통합 게이트 판정]
T-C (M4-1/2, k6) ──┼─ 머지 ──  G1~G5 pass/fail
T-B (M3-1→M3-4) ───┘   ▲        + M3-5 stage 배포·재측정
                        │
      머지 순서: T0 → T-A → T-C → T-B(rebase 후)
```

- T-B 내부 **중단 게이트**: M3-1 스파이크에서 g2g <6s 실측 실패 시 T-B 전체 중단(개선계획 ADR-10 리스크 규약). T-A·T-C는 영향 없음.

## 2. 브랜치·워크트리 규약

- 베이스: `main`. 각 트랙은 git worktree + 전용 브랜치:
  - `improve/t0-baseline` · `improve/ta-ingest` · `improve/tb-llhls` · `improve/tc-fanout`
- 커밋 규약은 기존 리포 관례(commitlint) 준수. 트랙 밖 파일 수정 금지 — **소유 파일 표(§1.2) 밖 diff가 생기면 그 라인은 되돌린다.**
- 머지는 통합 담당(오케스트레이터)만 수행. 순서: `t0` → `ta` → `tc` → `tb`(직전 rebase).

## 3. 실행 전제 (Opus 4.8 medium effort 보정)

medium effort 특성상 프롬프트에 탐색 여지를 남기지 않는다:

1. 각 프롬프트는 **must-read 파일 목록**과 **정확한 수정 지점**을 명시한다 (아래 §4).
2. 완료 판정은 반드시 **명시된 스모크 커맨드 실행 결과**로 한다. "코드 작성 완료" ≠ 완료.
3. 막히면(스파이크 실패, 스모크 불통 2회 반복) **추측으로 우회하지 말고 중단 후 보고**한다.
4. 기존 스모크 자산 재사용: `apps/svc-media/scripts/`의 `smoke.ts`, `smoke-ingest.ts`, `smoke-stream-30s.ts`, `seed-live.ts`.
5. 로컬 스택: `docker compose -f infra/docker-compose.yml up -d` (postgres/redis/minio/nginx) + `pnpm build` 선행.

## 4. 트랙별 킥오프 프롬프트 (에이전트에 그대로 전달)

### 4.1 T0 — 베이스라인 에이전트

```text
[역할] Streamix 미디어 성능 베이스라인 측정. 코드 수정 금지(신규 스크립트/문서만).

[must-read]
- 작업계획서-개선.md §1, §2(게이트 G1~G3), §4 M0
- apps/svc-media/src/main.ts, ingest.ts (측정 대상 파이프라인 이해)
- apps/svc-media/scripts/smoke-stream-30s.ts, smoke-ingest.ts (기존 송출 스모크 재사용)

[작업]
1. docker compose 스택 + svc-core/svc-media 로컬 기동, ffmpeg testsrc로 RTMP 송출.
2. CPU/RSS 베이스라인: 트랜스코딩 인제스트 경로(smoke-ingest 방식)로 5분 송출하며
   `docker stats`(또는 프로세스별 측정)를 30s 간격 샘플링. 스크립트로 자동화:
   apps/svc-media/scripts/perf-baseline.ts (신규).
3. 비트레이트 분포: 산출된 HLS 세그먼트를 ffprobe로 샘플링(정적 testsrc + 고복잡도
   소스(testsrc2 또는 노이즈 필터) 두 케이스), 세그먼트별 비트레이트 기록.
4. g2g 측정 절차 문서화 + 로컬 1회 실측: 송출 화면에 타임코드
   (ffmpeg drawtext '%{localtime}' 또는 testsrc timestamp) 삽입, hls.js 재생 화면과
   프레임 대조. OBS/브라우저 경로 각각 수치 기록. 자동화 불가 구간은 절차만 정확히 남긴다.
5. 결과를 docs/perf-baseline.md로: 수치 표 + 각 수치의 재현 커맨드 전문.

[소유 파일] docs/perf-baseline.md, apps/svc-media/scripts/perf-*.ts (신규만)
[금지] apps/ 기존 소스 수정 일체.

[완료 보고] perf-baseline.md 경로 + 핵심 수치 요약(CPU %, 비트레이트 min/median/max, g2g 초).
[중단 조건] 로컬 스택 기동 실패가 30분 내 해결 안 되면 환경 로그와 함께 중단 보고.
```

### 4.2 T-A — 인제스트 에이전트 (M1 → M2 → M4-3 직렬, 이 순서 필수)

```text
[역할] 브라우저 인제스트 경로 인코딩 최적화. 3단계를 순서대로, 단계마다 스모크로 닫고 커밋.

[must-read]
- 작업계획서-개선.md §1.2(결함 3~6), §3 ADR-9, §4 M1·M2·M4-3
- apps/svc-media/src/ingest.ts (전체), apps/svc-media/src/env.ts
- apps/web/components/broadcast.tsx (pickMimeType 이미 존재 — 확장 대상)
- apps/svc-media/scripts/smoke-ingest.ts (단계별 검증 도구)

[단계 1 — M1: 트랜스코딩 인자 수정] (ingest.ts의 ffmpeg spawn 인자만)
- 추가: -b:v/-maxrate = env.INGEST_VIDEO_BITRATE(기본 "2500k"), -bufsize = 그 2배.
- 교체: "-g","60" → "-force_key_frames","expr:gte(t,n_forced*2)" (프레임레이트 무관 2s 키프레임).
- 교체: "-ar","44100" → "-ar","48000".
- env.ts에 INGEST_VIDEO_BITRATE: z.string().default("2500k") 추가. 다른 설정 항목 추가 금지.
- OBS 권장 설정 가이드(키프레임 간격 2s, CBR)를 README.md 로컬 개발 섹션 아래 짧게 추가.
- 검증: smoke-ingest 통과 + 산출 세그먼트 ffprobe로 (a) 비트레이트가 2500k±10%,
  (b) 세그먼트 길이 ~2s 안정. 둘 다 수치를 보고에 포함.

[단계 2 — M2: 코덱 협상 remux] (ADR-9의 3단 분기)
- 먼저 반나절 스파이크: MediaRecorder video/mp4(fMP4) 청크를 stdin 파이프로 ffmpeg에
  넣어 -c copy -f flv → RTMP 재생이 되는지 실측(Node 스크립트로 브라우저 없이 재현 가능:
  ffmpeg로 fMP4 조각 생성 → 파이프). 실패하면 mp4 경로는 포기하고 webm;h264 경로만 구현,
  편차를 보고에 기록.
- broadcast.tsx: pickMimeType 후보를 ["video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/webm;codecs=h264", 기존 webm(vp8) 순]으로 확장, 선택 결과를
  /ingest?key=...&codec=mp4-h264|webm-h264|webm-vp8 로 전달.
- ingest.ts: codec 파라미터로 ffmpeg 인자 3분기 —
  mp4-h264: -c:v copy -c:a copy / webm-h264: -c:v copy -c:a aac -ar 48000 -b:a 128k /
  그 외·미지정: 단계 1의 트랜스코딩 인자(하위호환).
- 검증: smoke-ingest를 codec 파라미터별 3회(미지정 포함) 통과. copy 경로 CPU가
  트랜스코딩 대비 크게 낮음을 docker stats 1분 샘플로 확인(정식 G1 판정은 통합 단계).

[단계 3 — M4-3: 인제스트 backpressure]
- ingest.ts: sink.write() 반환값 false 시 누적 카운팅. 미플러시 바이트 상한
  env.INGEST_BUFFER_LIMIT_MB(기본 64) 초과 시 ws.close(4009, "ingest backpressure") 후
  ffmpeg 정리(기존 teardown 경로 재사용).
- 검증: ffmpeg 자리에 읽기를 지연시키는 가짜 sink를 주입하는 방식(또는 -readrate로
  쓰로틀)으로 상한 도달 → 4009 종료를 확인하는 스모크 1개 작성.

[소유 파일] apps/svc-media/src/ingest.ts, apps/svc-media/src/env.ts,
  apps/web/components/broadcast.tsx, README.md(OBS 가이드 1절만), 신규 스모크 스크립트.
[금지] main.ts, hls-server.ts, retention.ts, bff/**, chat 관련 일체.

[완료 보고] 단계별 커밋 해시 + 각 검증 수치(비트레이트, 세그먼트 길이, codec별 스모크 결과,
  backpressure 종료 코드 확인). 실패·편차는 그대로 보고.
[중단 조건] 단계 2 스파이크 실패는 중단 아님(편차 기록 후 webm;h264로 진행).
  같은 스모크 2회 연속 원인불명 실패 시 중단 보고.
```

### 4.3 T-B — 패키징 에이전트 (M3, 게이트 필수)

```text
[역할] HLS 패키징을 NMS+ffmpeg에서 MediaMTX(LL-HLS)로 전환. 스파이크 게이트 통과 시에만 본작업.

[must-read]
- 작업계획서-개선.md §1.3(검증 메모), §3 ADR-10, §4 M3, §5 리스크
- apps/svc-media/src/main.ts, hls-server.ts, retention.ts, env.ts (전환 대상 전체)
- infra/docker-compose.yml, docs/DEPLOY.md
- MediaMTX 공식 문서(README): RTMP 인제스트, LL-HLS 설정, runOnReady/runOnNotReady 훅

[게이트 — M3-1 스파이크(최대 2일)]
- infra/docker-compose.yml에 mediamtx 서비스 추가(기존 스택과 분리된 포트).
- ffmpeg testsrc(drawtext 타임코드 포함) → MediaMTX RTMP → 브라우저 hls.js 재생으로
  g2g 실측 3회. 판정: g2g < 6s AND 재생 시작 < 3s.
- **실패 시: 여기서 트랙 전체 중단, 수치와 설정 전문을 보고.** (OME 검토는 오케스트레이터 결정)

[본작업 — 게이트 통과 시]
- M3-2: 스트림키 검증/라이브 상태를 MediaMTX 훅으로 이관 — runOnReady에서 svc-media의
  HTTP 엔드포인트(신규, 내부 전용)를 호출하고 그 핸들러가 core.startStream을 호출.
  runOnNotReady → stopStream. heartbeat(30s)·SET NX 단일 writer 의미 유지.
  거절(키 무효) 시 MediaMTX가 퍼블리시를 닫도록 훅 종료코드/API 사용.
- M3-3: hls-server.ts를 서명 검증 리버스 프록시로 개조 — 기존 tokenValid(HMAC) 그대로,
  검증 통과 시 MediaMTX HLS(LL-HLS 플레이리스트·파트 포함)로 프록시. 플레이리스트 토큰
  재작성 로직은 LL-HLS 태그(#EXT-X-PART URI= 포함)까지 커버하도록 확장. 무서명 403 유지.
- M3-4: 썸네일 캡처를 MediaMTX RTMP(또는 HLS 세그먼트) 기준으로 수정, retention을
  새 세그먼트 경로 기준으로 수정, NMS 의존·ffmpeg HLS 패키징 spawn 제거
  (node-media-server 의존성 제거는 ingest.ts의 로컬 RTMP 수신처가 MediaMTX로 대체됨을
  확인한 뒤에만 — ingest.ts 자체는 수정 금지, RTMP 포트 호환만 보장).
- 검증: apps/svc-media/scripts/smoke.ts 계열 전체 + 서명 200/무서명 403 + 썸네일 200 +
  종료 후 reap. 로컬 g2g 재실측 수치 포함.
- 주의: fly.toml/DEPLOY.md 수정은 준비만(문서·설정 커밋), 실제 stage 배포(M3-5)는
  하지 않는다 — 통합 단계에서 오케스트레이터가 수행.

[소유 파일] apps/svc-media/src/main.ts·hls-server.ts·retention.ts, env.ts(경로 변수
  최소 수정 — 충돌 방지: 새 변수 추가는 파일 말미에만), infra/docker-compose.yml,
  fly.toml(svc-media), docs/DEPLOY.md, mediamtx 설정 파일(신규).
[금지] ingest.ts, broadcast.tsx, bff/**, 기타 web/**.

[완료 보고] 게이트 실측 수치(3회) → 통과 여부 → 본작업 커밋 목록 + 스모크 결과 전체.
[중단 조건] 게이트 실패(위 명시) / 스트림키 훅 이관에서 단일 writer 의미(SET NX)가
  깨지는 설계 밖에 안 나올 때.
```

### 4.4 T-C — 팬아웃 에이전트 (M4-1/2)

```text
[역할] 채팅 팬아웃 backpressure + 마이크로배칭. BFF와 프론트 chat 컴포넌트만.

[must-read]
- 작업계획서-개선.md §3 ADR-11(대체 결정 근거), §4 M4, §2 게이트 G4
- apps/bff/src/ws/chat.ts (전체 — 특히 rooms Map과 sub.on("message") 팬아웃 루프)
- apps/web/components/chat.tsx (수신 파싱 지점)

[작업]
1. backpressure: 팬아웃 루프에서 socket.bufferedAmount > 1MB(상수)면 해당 소켓 send skip,
   룸별 드롭 카운터를 60s 간격 로그. 연결 자체는 유지(채팅은 최신성 우선 — ADR-11).
2. 마이크로배칭: room에 큐 도입 — Redis message 수신 시 큐에 push, (a) 큐 길이 1이면
   즉시 flush(저부하 체감지연 0), (b) 이후 도착분은 50ms 타이머로 코얼레싱해
   JSON 배열 {type:"batch", items:[...]}로 전송. 타이머는 룸당 1개, 빈 큐면 정리.
3. chat.tsx: batch 타입 수신 시 items 순회 처리(기존 단건 포맷도 계속 수용 — 하위호환).
4. k6 WS 시나리오: 기존 부하 리그에 "슬로우 클라이언트 1개 주입" 케이스 추가 —
   1개 가상 유저만 수신을 인위 지연시키고 나머지 p95가 열화되지 않음을 검증하는 스크립트.
   (k6 리그가 리포에 없으면 scripts/k6-chat-fanout.js 신규 작성, 로컬 100 VU로 축소 실행.)

[검증] 로컬 기동 후 브라우저 2탭 채팅 왕복(기존 스모크 절차) + k6 축소 실행에서
  드롭 카운터·배칭 동작 로그 확인. 1,000VU 정식 판정(G4)은 통합 단계.

[소유 파일] apps/bff/src/ws/chat.ts, apps/web/components/chat.tsx, k6 스크립트(신규 허용).
[금지] svc-chat/**, svc-media/**, broadcast.tsx.

[완료 보고] 커밋 목록 + 로컬 검증 로그 요약(드롭 카운트, 배치 크기 분포, 왕복 확인).
[중단 조건] 배칭 도입 후 기존 채팅 E2E 해피패스가 깨지고 2회 시도 내 원인 못 찾을 때.
```

## 5. 통합·게이트 판정 (오케스트레이터 체크리스트)

머지·판정은 트랙 에이전트가 아닌 통합 담당이 수행한다:

1. [ ] T0 머지 → `docs/perf-baseline.md` 존재·재현 커맨드 확인.
2. [ ] T-A 머지 → `pnpm build && pnpm typecheck` + smoke-ingest(codec 3종).
3. [ ] T-C 머지 → 채팅 왕복 스모크 + 해피패스 E2E.
4. [ ] T-B rebase(env.ts 충돌 시 T-A 변수 유지 + T-B 변수 병기) → 머지 → 미디어 스모크 전체.
5. [ ] **M3-5 실행**: stage(Fly.io) 배포 + 배포 스모크(재생·무서명 403·채팅).
6. [ ] **게이트 판정** (T0 베이스라인 대비, 개선계획 §2):
   - G1: copy 경로 CPU 50%↓ — stage/로컬 재측정.
   - G2: maxrate ±10% — ffprobe (T-A 보고 수치로 갈음 가능).
   - G3: g2g <6s + 시작 <3s — stage 타임코드 대조.
   - G4: 1,000VU k6 + 슬로우 클라이언트 격리.
   - G5: 인제스트 버퍼 상한 스모크.
7. [ ] 미달 항목은 개선계획 규약대로 "수용된 편차 + 근거" 문서화 후 종료. 판정 결과를
       작업계획서-개선.md §4 각 항목에 체크 표기로 반영.

## 6. 전역 중단·조정 규칙

- T-B 게이트(M3-1) 실패 → T-B만 폐기, T-A·T-C 결과는 그대로 유효(G3만 편차 재수용).
- 어떤 트랙이든 소유 파일 밖 수정이 필요해지면 작업 중단 후 오케스트레이터에 보고(트랙 재편성 결정).
- 두 트랙이 같은 파일을 놓고 충돌 보고 시: 이 문서 §1.2 소유권 표가 판정 기준.
