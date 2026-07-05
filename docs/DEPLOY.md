# 배포 가이드 (ADR-8 하이브리드)

web=Vercel · 백엔드/미디어=Fly.io · HLS=Cloudflare R2(또는 svc-media 직접 서빙).
아래 절차는 **자격증명 확보 후** 실행한다. Phase 0~5는 완료, 배포 설정(Dockerfile·fly.toml·`.github/workflows/deploy.yml`)은 이미 리포에 있다.

> 🔒 이 문서의 모든 단계는 **계정·자격증명·도메인·결제**가 필요하다 — 그래서 루프는 여기서 보류하고 이 가이드를 남겼다.

## 0. 사전 준비 (계정 · CLI)

- 계정: **Fly.io**, **Vercel**, **Cloudflare**(R2). GitHub 리모트 저장소.
- CLI: `flyctl`(설치: `winget install Fly.Flyctl` 또는 `iwr https://fly.io/install.ps1 -useb | iex`), `vercel`(설치됨), `flyctl auth login` / `vercel login`.

## 1. 데이터 프로비저닝 (Fly)

```bash
# Postgres (svc-core)
flyctl postgres create --name streamix-db --region nrt
# Redis (Upstash via Fly, 또는 별도 Upstash 콘솔)
flyctl redis create --name streamix-redis --region nrt
```

각 명령이 출력하는 **connection string**(DATABASE_URL, REDIS_URL)을 보관.

## 2. 앱 생성 & 시크릿 (Fly, 배포 전)

앱은 fly.toml의 `app` 이름과 일치해야 한다. 각 서비스 디렉터리 기준 리포 루트에서:

```bash
# 앱 생성만 (배포는 3단계)
flyctl apps create streamix-svc-core
flyctl apps create streamix-svc-chat
flyctl apps create streamix-svc-media
flyctl apps create streamix-bff

# 공유 시크릿: JWT_SECRET·PLAYBACK_SECRET은 core/bff/media가 값이 같아야 함
JWT=$(openssl rand -hex 32); PB=$(openssl rand -hex 32)

flyctl secrets set -a streamix-svc-core \
  DATABASE_URL="<postgres-url>" REDIS_URL="<redis-url>" \
  JWT_SECRET="$JWT" PLAYBACK_SECRET="$PB"
flyctl secrets set -a streamix-svc-chat REDIS_URL="<redis-url>"
flyctl secrets set -a streamix-svc-media PLAYBACK_SECRET="$PB"
flyctl secrets set -a streamix-bff \
  REDIS_URL="<redis-url>" JWT_SECRET="$JWT" \
  CORS_ORIGINS="https://<your-vercel-domain>"
```

> `x-user-id`/`x-display-name` 전파, 서명 URL 등은 코드에 반영됨. JWT_SECRET이 core·bff에서 **동일**해야 토큰 검증이 맞는다.

## 3. 백엔드/미디어 배포 (Fly, 순서 중요)

svc-core를 먼저 (다른 서비스가 `.internal`로 참조). 리포 루트에서:

```bash
flyctl deploy --config apps/svc-core/fly.toml  --dockerfile apps/svc-core/Dockerfile
flyctl deploy --config apps/svc-chat/fly.toml  --dockerfile apps/svc-chat/Dockerfile
flyctl deploy --config apps/svc-media/fly.toml --dockerfile apps/svc-media/Dockerfile
flyctl deploy --config apps/bff/fly.toml       --dockerfile apps/bff/Dockerfile

# RTMP(1935)는 전용 IP 필요
flyctl ips allocate-v4 -a streamix-svc-media

# prod 마이그레이션 (로컬에서 prod DB로)
DATABASE_URL="<postgres-url>" pnpm --filter @streamix/db db:migrate
```

- svc-core `MEDIA_PUBLIC_URL`은 fly.toml에 `https://streamix-svc-media.fly.dev`로 설정됨(도메인 다르면 수정).
- BFF `CORE_URL`/`CHAT_URL`은 `http://streamix-svc-core.internal:50051` 등으로 설정 필요(현재 기본값 localhost → fly.toml `[env]`에 추가하거나 secrets로).

## 4. 웹 배포 (Vercel)

```bash
cd apps/web
vercel link            # 프로젝트 생성/연결, Root Directory = apps/web
vercel env add NEXT_PUBLIC_BFF_URL production   # https://streamix-bff.fly.dev
vercel env add NEXT_PUBLIC_WS_URL production    # wss://streamix-bff.fly.dev
vercel env add NEXT_PUBLIC_RTMP_URL production   # rtmp://streamix-svc-media.fly.dev:1935/live
vercel --prod
```

## 5. 크로스오리진 마감

- BFF `CORS_ORIGINS` = Vercel 도메인(+프리뷰 와일드카드). WS는 `wss://`.
- 재생 인가는 **토큰-in-URL**(쿠키 아님)이라 크로스오리진 GET으로 동작 — 별도 쿠키/SameSite 설정 불필요. R2/CDN 사용 시 버킷 CORS에 Vercel 오리진 허용.

## 6. CD 자동화 (GitHub Actions)

`.github/workflows/deploy.yml`가 `main` 머지 시 실행. 리포 시크릿 설정:

```bash
gh secret set FLY_API_TOKEN --body "$(flyctl auth token)"
gh secret set VERCEL_TOKEN  --body "<vercel-token>"
```

배포 후 스모크(`/health`) + 실패 시 롤백 스텝 포함. 롤백 수동: `flyctl releases rollback -a streamix-bff`.

## 7. 배포 후 스모크 (실 도메인)

```bash
curl -fsS https://streamix-bff.fly.dev/health
# OBS로 rtmp://streamix-svc-media.fly.dev:1935/live/<streamKey> 송출 →
#   https://<vercel-domain>/watch/<slug> 재생 + 채팅 왕복 확인
```

## MediaMTX LL-HLS 배포 (ADR-10 · M3-5 준비, 아직 미배포)

svc-media는 더 이상 NMS/ffmpeg로 HLS를 패키징하지 않는다. **MediaMTX**가 RTMP→LL-HLS를
담당하고, svc-media는 (1) 스트림키 검증(MediaMTX http auth 콜백), (2) 서명 URL 리버스
프록시(MediaMTX HLS 앞단), (3) 라이브 상태 lifecycle(control API 폴링)을 맡는다.

- **동일 머신 사이드카 필수**: `ingest.ts`(수정 금지)가 `rtmp://127.0.0.1:${RTMP_PORT}`로
  퍼블리시하므로 MediaMTX는 svc-media와 **같은 Fly 머신**에서 돌아야 한다(별도 앱 불가).
  fly.toml의 `1935` 서비스가 사이드카 MediaMTX로 라우팅된다.
- **Dockerfile 변경(배포 시)**: svc-media 이미지에 `mediamtx` 바이너리 + `infra/mediamtx.yml`을
  포함하고 두 프로세스를 함께 기동(예: 간단한 supervisor 또는 MediaMTX `runOnInit`으로 node
  기동). MediaMTX 이미지는 scratch라 셸이 없어 훅으로 HTTP 콜을 못 하므로, 검증/라이프사이클은
  http auth + control API로 구현되어 있다(코드 완료).
- **prod 설정 차이**: `infra/mediamtx.yml`의 `authHTTPAddress`는 dev에서 `host.docker.internal:8091`,
  prod(사이드카)에서는 `http://127.0.0.1:8091/mtx/auth`로 둔다(또는 `MTX_AUTHHTTPADDRESS` env로 주입).
- **RTMP 전용 IP**: 기존과 동일하게 `fly ips allocate-v4 -a streamix-svc-media`.
- **스모크(로컬 실측 완료)**: 서명 200 / 무서명·오토큰 403 / 썸네일 200 / 세그먼트·파트 프록시 200 /
  무효키 퍼블리시 거절 / 종료 후 reap / g2g(프록시 경유) ~2–3s·재생 시작 ~2s(게이트 <6s·<3s 충족).

## 남은 최적화 (선택)

- **R2 오프로딩**: 현재 svc-media가 HLS를 직접 서빙(서명 URL authz). CDN egress 절감을 위해 세그먼트를 R2에 업로드하고 `GetPlaybackUrl`을 R2 서명 URL로 전환. 로컬은 MinIO(S3 호환)로 검증 가능(`@aws-sdk/client-s3`).
- 풀 관측성(Grafana/Loki/OTel), ABR 다중 화질는 §1.2 후속.
