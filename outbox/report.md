# 개선작업 보고서 — inbox/review.md (보안 검토) 대응

작업일: 2026-07-12
대상 검토: `inbox/review.md` (검토일 2026-07-12)

## 이번 반복에서 완료한 항목

### P0-1. 구형 Connect Login/Refresh 우회 차단 — 완료

- `apps/bff/src/services/auth.proxy.ts`: public Connect `register`/`login`/`refresh`를
  `PermissionDenied`로 차단. 브라우저 인증은 REST `/auth/register`, `/auth/login`,
  `/auth/refresh`만 허용. `me`는 기존대로 유지.
- `apps/bff/src/auth.ts` `verifyAccessToken`: `jti` 없는 legacy access token 거부.
  denylist 검사는 모든 token에 항상 적용.

### P0-2. refresh rotation 원자화 + 재사용 탐지 강화 — 완료

- `apps/bff/src/session.ts` `rotateSession`을 Redis Lua script 하나로 재작성.
  검증·used 전환·successor 생성·family 갱신이 단일 원자 연산.
- used sid tombstone TTL을 60초에서 sliding window 전체(기본 30일)로 연장.
  60초 이후 과거 token 재사용도 family 탈취로 탐지·폐기됨.
- 60초 grace 안의 동시/중복 refresh는 family를 폐기하지 않고 동일 successor sid를
  idempotent하게 반환 (`next`/`usedAt` 필드 추가).

검증 (로컬 Redis smoke test, 실행 후 삭제):

- 동시 refresh 20건: 전부 동일 successor 1개 반환 (이전 코드는 복수 유효 세션 생성 가능)
- successor 정상 회전: ok
- grace(60s) 경과 후 과거 sid 재사용: `reuse` → family 폐기
- family 폐기 후 최신 sid 사용: `invalid`

### P0-3. register/login rate limit 및 Argon2 자원 고갈 방어 — 완료

- `apps/bff/src/routes/auth.ts`:
  - REST `/auth/register`에 IP 기반 rate limit 추가 (기존에 전무).
  - REST `/auth/login`에 기존 per-email 제한에 더해 IP 기반 제한 추가.
    rate-limit key용 이메일은 trim+소문자 canonicalization (upstream 호출 값은 유지).
- `apps/bff/src/rate-limit.ts`: auth 전용 `overLimitAuth` 추가 — Redis 장애 시
  fail-open 대신 process-local fixed-window fallback으로 계속 제한 (10k key 상한).
  일반 RPC의 fail-open `overLimit`은 그대로 유지.

### P1-2. production secret/cookie fail-fast — 완료

- `apps/bff/src/env.ts`: `NODE_ENV=production`에서 `JWT_SECRET`(개발 기본값 금지,
  32자 이상), `REDIS_URL`, `CORS_ORIGINS`, `COOKIE_SAMESITE` 필수.
  `COOKIE_SECURE=true` 필수, `SameSite=None`+`Secure` 조합 검증. 위반 시 process 종료.
- `apps/svc-core/src/env.ts`: `JWT_SECRET`, `PLAYBACK_SECRET`(32자 이상, 기본값 금지),
  `DATABASE_URL`, `REDIS_URL` 필수 검증.
- `apps/svc-media/src/env.ts`: `PLAYBACK_SECRET` 동일 검증.

## 검증 결과

- `pnpm --filter @streamix/bff|svc-core|svc-media typecheck`: 통과
- `pnpm --filter @streamix/bff|svc-core|svc-media lint`: 통과
- P0-2 Redis smoke test: 4/4 통과 (위 상세)

---

# 2차 반복 (2026-07-12) — P1 항목 대응

## 완료

### P1-1. family 단위 access token 폐기 — 완료

- `apps/bff/src/token.ts`: `mintAccess`가 refresh family id를 `fam` claim으로 포함.
  `deny:fam:{family}` marker + `isFamilyDenied` 추가 (TTL = access TTL).
- `apps/bff/src/session.ts`: family revoke(JS `revokeFamily` + Lua reuse/expired 경로)
  시 `deny:fam` marker 설정. `createSession`이 `{sid, family}` 반환,
  `rotateSession` ok 결과에 family 포함.
- `apps/bff/src/auth.ts` `verifyAccessToken`: `fam` claim 있으면 family 폐기 여부 검증.
- `routes/auth.ts`(login/refresh), `routes/twitch.ts` 호출부 갱신.
  Redis 장애로 세션 없이 발급된 token은 `fam` 없이 자연 만료 (기존 degradation 유지).

검증 (Redis smoke, 실행 후 삭제): family revoke 후 같은 family에서 발급된 access
token이 즉시 `null` (이전엔 최대 15분 유효). 동시 rotation 회귀 20/1 유지.
no-fam token 정상 동작.

### P1-4. ingest pre-auth 자원 제한 — 완료

- `apps/svc-media/src/ingest.ts`: 인증 전 pending buffer 8MB 상한 (초과 시 4009 종료),
  `WebSocketServer maxPayload` 16MB, 전체 동시 ingest 연결 32개 상한 (초과 시 1013).

### P1-5. trusted proxy — 완료

- `apps/bff/src/main.ts`: Fastify `trustProxy: 1` (Fly proxy 1 hop만 신뢰).
- `apps/bff/src/rate-limit.ts`: Connect interceptor의 IP key를 XFF 첫 값(spoofable)
  대신 마지막 값(proxy가 append한 실제 client)으로 변경.

### P1-3 (부분). log redaction — 완료

- `apps/bff/src/main.ts`: Fastify logger에서 `authorization`, `cookie`, `set-cookie`
  redaction.

## 검증 결과 (2차)

- `pnpm --filter @streamix/bff|svc-media typecheck` + lint: 통과
- Redis smoke 5/5: 동시 rotation 1 successor, family revoke → access 즉시 무효,
  post-revoke rotate invalid, no-fam token 유효

---

# 3차 반복 (2026-07-12) — §7 검증 피드백 (V1-1~V1-6) 대응

검증자 참고: V1-3이 지적한 `trustProxy` 부재는 이미 2차 반복 커밋 `eb6d93c`에서
반영되어 있었음 (`main.ts` `trustProxy: 1` + interceptor XFF 마지막 값 사용 —
검증 시점의 `b9e3af0`에는 없던 변경).

## 완료

### V1-1. smoke-session.ts를 새 정책으로 갱신 — 완료

`apps/bff/scripts/smoke-session.ts` (21 케이스로 확장, 재실행 가능한 repository test):

- grace 안 old sid 재사용 → 200 + 동일 successor (idempotent)
- 동시 refresh 20건 → 전부 200, successor 정확히 1개
- grace 경과 후 old sid 재사용 → 401 `reuse` + family revoke
- revoke 후 최신 sid → 401, 같은 family의 access token → Unauthenticated (P1-1 검증)
- public Connect `Login/Register/Refresh` → `PermissionDenied` (V1-4 지시 중 테스트 항목)
- 60초 대기 대신 `REFRESH_GRACE_MS` env로 grace 설정화 (기본 3s, 테스트에서 단축 가능)

**실행 결과: 21/21 PASS** (로컬 풀스택: postgres+redis+svc-core+bff, UNLINK 반영 후 재실행도 PASS)

### V1-2. grace 60초 → 3초 축소 + 설정화 — 완료

- `apps/bff/src/env.ts`: `REFRESH_GRACE_MS` (기본 3000ms).
- `apps/bff/src/session.ts`: 하드코딩 60초 제거. 탈취 old sid의 successor 승격 창이
  60초에서 3초로 축소. successor 재전달 위험은 코드 주석에 명시.
- 잔여: web client refresh single-flight (grace 완전 제거 전제조건) — 별도 작업.
  DPoP 계열은 범위 외로 유지.

### V1-3. 전역 concurrency 상한 — 완료 (trustProxy는 2차에서 기완료)

- `apps/bff/src/routes/auth.ts`: register/login에 전역 in-flight 상한 16 (초과 시 503).
  proxy 판별이 무너져도 Argon2 CPU 사용이 유계.
- 잔여: production에서 `req.ip`가 실 client IP인지 integration 확인 (Fly 배포 시).

### V1-4. JWT claim 검증 강화 — 완료

- `apps/bff/src/token.ts`: 발급 시 `iss=streamix-bff`, `aud=streamix-web`,
  protected header `typ: JWT`.
- `apps/bff/src/auth.ts`: 검증 시 `algorithms: ["HS256"]`, issuer, audience 강제
  (`verifyAccessToken` + `tokenMeta` 둘 다).
- Connect 차단 자동 테스트는 smoke에 포함 (위 V1-1).
- 주의: 배포 시 기존 발급 token(iss/aud 없음)은 즉시 무효 → silent refresh로 재발급됨 (최대 15분 창).

### V1-6 (부분). 대량 revoke 시 Redis 블로킹 완화 — 완료

- `session.ts` JS·Lua 양쪽 family revoke를 `DEL` → `UNLINK` (async reclaim).
- 잔여: 30일 지속 refresh 시 family당 key 수·memory 측정, Fly/Upstash topology에서
  Lua multi-key staging 검증, Cluster 대비 hash tag 설계 — 운영 측정 작업으로 보류.

### V1-5. production SameSite 강제 — 완료

- `apps/bff/src/env.ts`: production에서 `COOKIE_SAMESITE=none` 필수로 강화
  (split-origin Vercel<->Fly 전제, lax/strict면 기동 실패). same-origin 전환 시
  재검토 주석 명시.
- 잔여: env validation 자동 테스트 (기동 실패 케이스) — process.exit 검증 하니스 필요.

## 검증 결과 (3차)

- typecheck·lint·build: 통과
- **smoke-session.ts 21/21 PASS** (신규 grace/동시성/Connect 차단/P1-1 케이스 포함)

---

# 4차 반복 (2026-07-12) — P2-2 / P2-3 / §6 문서 정합성

review.md 신규 갱신 없음 — 잔여 항목 진행.

## 완료

### P2-2. chat WebSocket origin·자원 제한 — 완료

- `apps/bff/src/main.ts`: WS handshake에서 Origin이 CORS allowlist에 없으면 4403
  종료 (Origin 없는 비브라우저 클라이언트는 통과 — token 검증은 그대로 필요).
- `apps/bff/src/ws/chat.ts`:
  - `channelId` UUID 형식 검증 — 임의 문자열마다 room + Redis 구독 생성 차단.
  - 사용자당 동시 socket 10개, instance당 총 2000개 상한 (초과 4429).
  - 30초 ping/pong heartbeat — pong 1회 누락 시 terminate (유휴 좀비 정리).

### P2-3. security header + /metrics 보호 — 완료

- `apps/web/next.config.ts`: 전 경로 보안 헤더 — CSP(`frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'self'`), HSTS(2y+subdomains), `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`(camera/mic/display-capture=self — studio 방송 유지).
  nonce 기반 script-src CSP는 middleware 필요로 보류 명시.
- `apps/bff/src/main.ts` + `env.ts`: `/metrics`는 `METRICS_TOKEN` 설정 시 Bearer
  일치 요구(불일치 401), 미설정 시 production에서 404 (dev만 공개).

### §6. docs/auth-session.md 정합성 — 완료

현재 구현에 맞게 갱신: iss/aud/alg 고정·jti 필수·fam claim, Connect credential
RPC 차단(core stateless RPC 잔존 명시), Lua 원자 회전·3s grace·전 window
tombstone, family 단위 access token 폐기, grace 창 내 탈취 replay 한계(known
limitation) 명시, production fail-fast 섹션 추가, smoke 15/15 → 21/21.

## 검증 결과 (4차)

- typecheck·lint: bff/web 통과
- WS guard smoke (일회성, 실행 후 삭제): 적대 Origin 4403 / 비UUID channelId
  4000 / 위조 token 4001 / dev `/metrics` 200 — 4/4 PASS
- `smoke-session.ts` 회귀: 21/21 PASS

---

# 5차 반복 (2026-07-12) — §8·§9 검증 피드백 (V2-1~~V2-5, V3-1~~V3-4) 대응

주의: §8(2차 검증)은 4차 반복 시점에 파일에 있었으나 누락 처리됨 — 이번에 §9와 함께 처리.
검증자 우선순위(V2-1 → V2-2 → V3-1 → CI smoke) 순서로 구현.

## 완료

### V2-1. logout/refresh race로 인한 family 부활 — 완료 (P0)

- `apps/bff/src/session.ts`: JS `revokeFamily`(SMEMBERS 후 별도 MULTI)를 단일
  Lua script(`REVOKE_LUA`)로 원자화. rotate와 revoke 모두 Lua이므로 Redis
  single-thread에서 interleaving 자체가 불가능.
- marker 이원화 (지시 3): `deny:fam:{f}`(access 검증용, TTL=access TTL) +
  `famrev:{f}`(refresh 부활 방지용, TTL=sliding window — 어떤 sid도 이보다
  오래 못 삶).
- rotate Lua 시작부에서 `famrev` 확인 — 존재 시 sid 삭제 후 `invalid` 반환
  (지시 2). rotate 내부 reuse/expired revoke 경로에도 `famrev` 설정.
- race 자동 테스트 (지시 5): smoke에 logout‖refresh 동시 실행 3회 추가 —
  refresh가 이겨 successor를 받아도(200) 이후 refresh는 401.
  **실측: 3회 모두 refresh=200 이후 401 — 가드 동작 확인.**

### V2-2. ACCESS_TTL parser 불일치 — 완료 (P1)

- `apps/bff/src/env.ts`: `ACCESS_TTL`을 `^\d+[smh]$` 형식으로 제한 + 1h 상한
  (schema 위반 시 기동 실패).
- `apps/bff/src/token.ts` `accessTtlSec()`: silent 900s fallback 제거, 미지원
  형식이면 throw.

### V3-1. Argon2 동시성 제한을 core로 이동 — 완료 (P0)

- `apps/svc-core/src/auth/password.ts`: process-wide semaphore — 동시 2
  (2×64MiB ≈ 128MiB, 256MiB instance에서 여유 확보), 대기 queue 32 상한,
  대기 timeout 5s, 초과 시 `RATE_LIMITED`(→`ResourceExhausted`).
  hash·verify 모두 gate 통과 (지시 1~3).
- BFF의 in-flight 16 상한은 edge rejection으로 유지 (지시 4).
- 잔여 (지시 5): 32+ 동시 부하에서 RSS/latency/reject 측정 — 부하 리그 작업.

### V3-2. REFRESH_GRACE_MS 범위 강제 — 완료

- `.int().min(0).max(5000)` schema 제한. 오설정으로 grace 창 재확대 불가.

### V3-3 (부분). smoke 실행 진입점 — 완료 / CI job — 보류

- `apps/bff/package.json`에 `smoke:session` script 추가
  (`pnpm --filter @streamix/bff smoke:session`).
- CI integration job(격리 DB/Redis 기동)은 workflow 작업으로 보류.

## 검증 결과 (5차)

- typecheck·lint·build: bff/svc-core 통과
- **smoke-session 24/24 PASS** (기존 21 + V2-1 race 3) — 로컬 풀스택
  (postgres+redis+svc-core+bff 실기동). §9에서 검증자가 재현 못한 21/21도
  이번 실행에 포함됨.

---

# 6차 반복 (2026-07-12) — V3-3 CI / V2-5 handshake / P2-4 계정 정책

review.md 신규 갱신 없음 — 잔여 항목 진행.

## 완료

### V3-3. CI session integration job — 완료

- `.github/workflows/ci.yml`에 `session-integration` job 추가: postgres/redis
  service container 기동 → proto codegen → build → migrate → svc-core+BFF 실행
  → health 대기 → `smoke:session` 실행. `REFRESH_GRACE_MS=1000`으로 대기 단축.
- 잔여: `pnpm audit` CI gate는 P2-5 의존성 업데이트 완료 후 추가 (지금 넣으면
  기존 drizzle-orm high advisory로 즉시 실패).

### V2-5 (부분). ingest handshake 단계 검사 — 완료

- `apps/svc-media/src/ingest.ts`: `verifyClient`로 WS upgrade 이전에 거부 —
  capacity(32), browser Origin allowlist(신규 `INGEST_ALLOWED_ORIGINS` env,
  빈 값=미필터), IP별 handshake 10회/분.
- 보류: bit_ token 원자적 1회 소비 — ADR-14 카메라 전환 재시작이 동일 token으로
  재연결하는 흐름이라 web의 재발급 협조 필요 (단독 변경 시 카메라 전환 파손).
  ingest metrics 노출도 보류.

### P2-4. 계정·입력 정책 — 완료

- `packages/schemas`: `emailSchema` trim+lowercase canonicalization(+254 상한),
  `passwordSchema` min 12 (복잡도 규칙 없음 — 길이 우선), 신규
  `loginPasswordSchema`(min 1 — 12자 정책 이전 계정 로그인 보존), 신규
  `displayNameSchema`(trim, 2~50자, 제어문자·행분리자 거부).
- `apps/svc-core/auth.service.ts`: register가 email canonical form 저장 +
  displayName server-side 검증. **검증 실패를 `VALIDATION`(→400)으로 매핑**
  — 기존엔 ZodError가 그대로 새서 502였음 (이번에 발견·수정).
  login은 canonical 조회 후 legacy(canonicalization 이전 저장) row로 fallback.
- `apps/web/app/signup/page.tsx`: 비밀번호 min 12 반영.
- 기존 smoke들의 11자 비밀번호(`hunter2pass`)를 12자+로 일괄 갱신 (5개 파일).
- 보류 (review 지시 중): 유출 비밀번호 차단, 이메일 인증, password reset,
  MFA/WebAuthn, 감사 로그 — 기능 단위 별도 작업.

## 검증 결과 (6차)

- typecheck·lint·build: schemas/svc-core/svc-media/bff/web 통과
- `smoke:session` 24/24 PASS (새 정책 반영 후 재실행)
- 정책 실검증: 9자 비밀번호 register → 400, 제어문자 displayName → 400,
  `"  MiXeD@Ex.COM "` 등록 후 `"MIXED@ex.com  "` 로그인 → 200 (canonical 일치)

## 남은 항목 (다음 반복 대상)

- P2-5: `drizzle-orm>=0.45.2`, `postcss>=8.5.10` 업데이트 + migration 회귀
  - CI audit gate (업데이트 후)
- V2-5 잔여: bit_ token 1회 소비 (web 재발급 협조), ingest metrics
- V2-4: trusted proxy Fly 실환경 증거 (staging 배포 시 req.ip/XFF 확인) —
  P1-5는 "구현 완료, 배포 검증 대기" 상태 유지
- V2-5: ingest handshake 단계(verifyClient) origin/IP rate/capacity 검사,
  ingest token 원자적 1회 소비, ingest metrics
- V3-3 잔여: CI integration job (격리 postgres/redis + smoke 실행)
- V3-4: access token protected header `at+jwt` (낮은 우선순위)
- V1-2 잔여: web client refresh single-flight
- P2-1: 내부 서비스 인증 (mTLS 또는 service JWT — 구조 작업)
- P2-4: 계정·입력 정책 (비밀번호 12+, email canonicalization, display name 검증)
- P2-5: `drizzle-orm>=0.45.2`, `postcss>=8.5.10` 업데이트 + CI audit
- P1-3 잔여: chat WS token query 제거(첫 frame/ticket), ingest durable key 거부,
  HLS token TTL 축소
- prod 배포·검증: 지금까지의 수정 전부 미배포 (bff/core/media + web 재배포 필요,
  METRICS_TOKEN Fly secret 결정 필요)
- V1-2 잔여: web client refresh single-flight 후 grace 제거 검토
- V1-3 잔여: production `req.ip` integration 확인 (Fly 재배포 시점)
- V1-5 잔여: env fail-fast 자동 테스트
- V1-6 잔여: family key 규모·revoke latency 운영 측정, Redis topology 검증
- P1-3 (잔여): chat WS token을 query 대신 첫 frame/1회용 ticket으로, browser ingest의
  durable stream key 거부(bit_ 토큰만), HLS query token TTL/Referrer-Policy.
  URL 자체(query string)는 아직 로그에 남을 수 있음 — 필요 시 serializer 추가.
- P1-4 (잔여): IP별 handshake rate limit, web origin 검사
- P2-1 ~ P2-4: 내부 서비스 인증, WS origin/자원 제한, security header·/metrics 보호, 계정 정책
- P2-5: `drizzle-orm>=0.45.2`, `postcss>=8.5.10` 업데이트 + CI audit
- 회귀 테스트 suite 부재 — bff에 테스트 프레임워크 없음. review §5의 테스트를
  자동화하려면 vitest 도입 필요 (이번엔 일회성 smoke test로 대체)
- `docs/auth-session.md` 정합성 수정 (§6): P0 수정 반영해 갱신 필요

## 비고

- core의 stateless `Login/Refresh` RPC 자체(`apps/svc-core`)는 유지됨 — BFF public
  surface에서만 차단. review 권장 2안(core token 발급 제거)은 proto 변경이 필요한
  구조 변경이라 별도 작업으로 남김.
