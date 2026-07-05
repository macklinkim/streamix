# 미디어 성능 베이스라인 (M0)

> 개선 작업계획서(`작업계획서-개선.md`) §4 M0 산출물. 이후 게이트 G1(CPU 50%↓)·G2(maxrate ±10%)·G3(g2g <6s)의 "대비" 기준 수치.
> 측정일: 2026-07-05 · 측정 스크립트: `apps/svc-media/scripts/perf-baseline.ts`, `perf-bitrate.ts`, `perf-g2g.ts` (본 문서와 함께 M0에서 신규 추가, 앱 소스 무수정)

## 0. 측정 환경

| 항목                 | 값                                                                              |
| -------------------- | ------------------------------------------------------------------------------- |
| 머신                 | Windows 11 Home (로컬 dev), 논리 코어 12개                                      |
| Node                 | v22.18.0 · pnpm 9.15.9                                                          |
| svc-core / svc-media | 로컬 프로세스 (`node --import tsx src/main.ts`), NMS v2.7.4                     |
| ffmpeg (파이프라인)  | `ffmpeg-static` 5.3.0 (인제스트/패키징이 실제 사용하는 바이너리)                |
| ffprobe (측정용)     | 8.1.2 (scoop, PATH)                                                             |
| 인프라               | `docker compose -f infra/docker-compose.yml up -d` (postgres/redis/minio/nginx) |

측정 대상 서비스가 호스트 프로세스라 `docker stats`는 적용 불가 → 프로세스별 샘플링(PowerShell `Get-Process` TotalProcessorTime/WorkingSet64, 30s 간격 차분)으로 대체. CPU 값은 **코어 수 기준**(1.0 = 코어 1개 100%)과 %(=코어×100) 병기. Fly stage 수치는 stage 측정 시 별도 추가할 것(본 문서는 dev 로컬).

공통 기동 절차(재현):

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d
pnpm --filter @streamix/db build && pnpm --filter @streamix/db db:migrate
pnpm --filter @streamix/proto --filter @streamix/schemas --filter @streamix/config build
# 터미널 1
cd apps/svc-core  && node --import tsx src/main.ts
# 터미널 2
cd apps/svc-media && node --import tsx src/main.ts
```

## 1. 인제스트 CPU/RSS 베이스라인 (G1 대비 기준)

브라우저 송출 경로(`ingest.ts`: webm/VP8+Opus → WS → ffmpeg libx264 veryfast 풀 트랜스코딩 → RTMP)를 스트리머 1명으로 5분 송출, 30s 간격 10샘플. 소스는 720p30 두 케이스.

- **static**: `testsrc` (저엔트로피 컬러바)
- **complex**: `testsrc2` + `noise=alls=40:allf=t+u` (고엔트로피 — 실사/게임 방송 근사)

| 지표 (스트리머 1명)                  | static                   | complex                    |
| ------------------------------------ | ------------------------ | -------------------------- |
| 트랜스코더 ffmpeg CPU 평균           | **0.365 코어 (36.5%)**   | **1.148 코어 (114.8%)**    |
| 트랜스코더 ffmpeg CPU 최대(30s 윈도) | 0.424 코어               | 1.544 코어                 |
| 트랜스코더 ffmpeg RSS                | 평균 63.1 / 최대 63.7 MB | 평균 63.2 / 최대 63.9 MB   |
| svc-media node CPU 평균              | 0.008 코어               | 0.028 코어                 |
| svc-media node RSS                   | 평균 90.5 / 최대 91.1 MB | 평균 107.4 / 최대 110.2 MB |

판독:

- CPU의 사실상 전부가 **libx264 재인코딩**이다(node 프로세스는 ~0.01 코어). ADR-9 copy remux가 제거할 수 있는 몫이 곧 이 수치.
- 고복잡도 소스에서 스트리머 1명이 **코어 1개를 초과**(1.15 코어) — Fly shared-cpu-1x 기준으로 스트리머 1명이 머신 하나를 넘어서는 수준. G1(50%↓)의 절대 기준: **complex 1.148코어 → 목표 ≤0.574코어**, static 0.365 → ≤0.183.
- 원시 샘플 JSON: 실행 시 `apps/svc-media/perf-out/baseline-{static,complex}.json` 생성(리포 미포함, 재현 커맨드로 재생성).

재현:

```bash
cd apps/svc-media
PERF_SOURCE=static  PERF_DURATION=300 PERF_INTERVAL=30 node --import tsx scripts/perf-baseline.ts
PERF_SOURCE=complex PERF_DURATION=300 PERF_INTERVAL=30 node --import tsx scripts/perf-baseline.ts
```

스크립트가 스모크(smoke-ingest)와 동일한 계정/채널 셋업 → WS 송출 → 라이브 확인 → PID 샘플링 → 종료 직전 HLS 세그먼트를 `perf-out/hls-<source>`로 스냅샷까지 자동 수행한다.

## 2. 인제스트 출력 비트레이트 분포 (G2 대비 기준)

§1 송출 산출물(HLS 세그먼트)을 ffprobe로 세그먼트별 측정(비트레이트 = 파일 바이트×8 / ffprobe duration). 라이브 플레이리스트는 `hls_list_size=4 + delete_segments`라 스냅샷에는 마지막 ~5세그먼트가 남는다.

| 케이스                                     | 세그먼트 수 | 비트레이트 kbps (min / median / max) | 세그먼트 길이 s (min / median / max) |
| ------------------------------------------ | ----------- | ------------------------------------ | ------------------------------------ |
| 트랜스코딩·static                          | 15          | **642 / 668 / 714**                  | 2.00 / 2.00 / 2.00                   |
| 트랜스코딩·complex                         | 5           | **11,103 / 11,249 / 12,006**         | **1.18 / 2.07 / 2.80**               |
| (참고) RTMP `-c copy` 경로, 2500k CBR 소스 | 5           | 1,207 / 1,215 / 1,253                | 2.00 / 2.00 / 2.00                   |

판독 (계획서 §1.2 결함 3·4의 정량 증명):

- **레이트 컨트롤 부재**: `-b:v`/`-maxrate` 없는 CRF 23 기본값에서, 같은 720p30 입력이 장면 복잡도에 따라 **668 kbps ↔ 11.2 Mbps (약 17배)** 로 폭주. complex의 11~~12 Mbps는 시청자 다운링크를 그대로 압박한다. → M1 목표: maxrate 2500k 설정 시 모든 세그먼트가 2250~~2750 kbps(±10%) 안에 들어와야 G2 통과.
- **GOP-세그먼트 미정렬**: static은 정확히 2.00s 세그먼트지만 complex에서 `-g 60`(30fps 가정 2s)이 인코더 사정에 따라 흔들리며 세그먼트가 **1.18~2.80s**로 벌어짐. `-force_key_frames expr:gte(t,n_forced*2)`(M1)의 대비 기준.
- static 표본 15개는 동일 소스 설정의 검증 런(30s)+본 런(5분) 스냅샷 합산(모두 642~714 kbps로 균질).

재현 (§1 실행 후):

```bash
cd apps/svc-media
node --import tsx scripts/perf-bitrate.ts perf-out/hls-static
node --import tsx scripts/perf-bitrate.ts perf-out/hls-complex
# ffprobe가 PATH에 필요 (예: scoop install ffmpeg). FFPROBE env로 바이너리 지정 가능.
```

## 3. g2g(glass-to-glass) 지연 (G3 대비 기준)

### 3.1 측정 절차 (표준화)

1. `scripts/perf-g2g.ts` 실행 — 호스트 벽시계를 `drawtext text='%{localtime}'`로 프레임에 번인한 testsrc를 송출하고, 라이브 확인 후 `perf-out/g2g.html` 생성.
   - `PERF_G2G_PATH=ws`(기본): 브라우저 경로 — webm 청크를 WS `/ingest`로 전송, `ingest.ts` 풀 트랜스코딩 경유 (스튜디오 페이지와 동일 경로).
   - `PERF_G2G_PATH=rtmp`: OBS 경로 — H.264+AAC FLV를 `rtmp://127.0.0.1:1935/live/<key>`로 직접 publish (키프레임 2s = OBS 권장 설정과 동일), `main.ts` `-c copy` 패키징 경유.
2. `g2g.html`을 **같은 머신** 브라우저에서 HTTP로 연다(file:// 불가 시 `npx http-server perf-out` 등). 페이지는 hls.js(liveSyncDurationCount=3, 기본값)로 서명 URL을 재생하며 상단에 JS 벽시계(ms 단위)를 함께 표시한다.
3. 재생 안정화(~15s) 후 화면을 캡처한다. **g2g = (페이지 NOW 시계) − (영상 안 번인 시계)**. 번인 시계는 초 단위이므로 판독 오차 ±0.5s. 20s 이상 간격으로 3회 이상 샘플링해 평균낸다.
4. 실제 OBS로 측정할 때는 OBS 소스에 장면 타임코드(예: 브라우저 소스로 시계 페이지)를 넣고 keyframe interval 2s, CBR로 송출 — 나머지는 동일. (본 실측은 OBS 대신 동일 인자의 ffmpeg RTMP publish로 대체 — 인코더 설정이 같아 파이프라인 지연은 등가.)

```bash
cd apps/svc-media
PERF_G2G_SECONDS=240 node --import tsx scripts/perf-g2g.ts                 # 브라우저 경로
PERF_G2G_PATH=rtmp PERF_G2G_SECONDS=240 node --import tsx scripts/perf-g2g.ts  # OBS 경로
```

### 3.2 실측 결과 (dev 로컬, hls.js 기본 설정, Chromium)

| 경로                    | 샘플 1 | 샘플 2 | 샘플 3 | **평균 g2g** |
| ----------------------- | ------ | ------ | ------ | ------------ |
| OBS(RTMP `-c copy`)     | 7.6s   | 7.3s   | 7.6s   | **≈7.5s**    |
| 브라우저(WS 트랜스코딩) | 9.4s   | 9.1s   | 8.7s   | **≈9.1s**    |

증빙 스크린샷(두 시계가 한 화면에): `docs/assets/perf-baseline/g2g-rtmp-shot{1..3}.png`, `g2g-shot{1..3}.png`

판독:

- 두 경로 모두 계획서가 기록한 6~10s 편차 범위를 재확인. **G3(<6s) 미달** — 표준 HLS(2s×4세그먼트 윈도 + hls.js 3세그먼트 라이브 싱크)만으로 이론 하한이 ~6s라 M3(LL-HLS/MediaMTX) 없이는 닫을 수 없음(ADR-10 근거 수치).
- 브라우저 경로가 OBS 경로보다 ~1.6s 느림 = MediaRecorder 청크 버퍼링 + libx264 재인코딩 몫. ADR-9 remux가 이 갭도 일부 줄일 것으로 예상.
- 재생 시작(<3s 게이트)은 본 실측에서 별도 계측하지 않음 — 절차: 페이지 로드 순간과 `video` 첫 프레임 표시(`v.currentTime > 0`) 사이를 측정. M3 판정 시 함께 계측할 것.

## 4. 게이트 대비 기준 요약

| 게이트            | 베이스라인 수치                                     | 통과 기준                                     |
| ----------------- | --------------------------------------------------- | --------------------------------------------- |
| G1 (CPU 50%↓)     | 트랜스코더 static 0.365코어 / complex **1.148코어** | H.264 브라우저에서 각각 ≤0.183 / ≤0.574코어   |
| G2 (maxrate ±10%) | complex 세그먼트 **11.1~12.0 Mbps** (무제한 CRF)    | maxrate 2500k 기준 전 세그먼트 2250~2750 kbps |
| G3 (g2g <6s)      | OBS **≈7.5s** · 브라우저 **≈9.1s**                  | 양 경로 <6s (stage 실측), 재생 시작 <3s       |
