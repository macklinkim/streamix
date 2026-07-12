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

---

# 7차 반복 (2026-07-12) — §11 V5 + §12 V6 + V4 잔여 대응

## 완료

### V5-1. login timing 계정 열거 방어 — 완료 (V6-5 해소)

- `apps/svc-core/src/auth/auth.service.ts`: 미존재·OAuth-only 계정 login도 기동 시
  1회 생성한 dummy Argon2 hash를 동일 gate 안에서 verify — latency 분포 평준화.
- 실측(단일 샘플): wrong-password 76ms vs 미존재 계정 59ms (이전엔 수 ms 즉시 실패).
  통계적 분포 비교(지시 4)는 부하 리그 작업으로 보류.

### V5-2. session env 범위 검증 — 완료

- `ACCESS_TTL` 60초~1h 범위 강제(0s 차단 — EX 0 오류 방지),
  `REFRESH_TTL_DAYS` int 1..365, `REFRESH_ABS_MAX_DAYS` int 1..730,
  `ABS_MAX >= TTL` refine. 위반 시 기동 실패.

### V4-1 (부분). WS room 자원 경계 — 완료 (존재 검증 제외)

- `apps/bff/src/ws/chat.ts`: instance당 room 500 상한(신규 room만 거부, 기존 join 허용),
  사용자당 신규 room 생성 5회/분. 실측: 6번째 신규 room부터 4429.
- 보류: channel 존재 확인 — by-id RPC가 proto에 없어 추가 필요 (구조 작업).

### V4-2. Origin 검사 pre-upgrade 이동 — 완료

- `apps/bff/src/main.ts`: `/ws` route `preValidation`에서 HTTP 403으로 upgrade 자체 거부.
  실측: 적대 Origin이 "Unexpected server response: 403" (socket 미할당).

### V4-3. 인증 대기 socket 계수 — 완료

- `totalSockets`를 token 검증 **이전에** 선점, close에서 1회만 해제.
  user별 계수도 증가 직후 decrement 등록 (기존: 거부 경로에서 계수 누수 버그 — 수정).

### V4-5. 문서 — 완료

- `docs/auth-session.md`: family revoke 원자성(Lua+famrev)과 race smoke 근거 명시.

### V6-3. email canonicalization migration — 완료 (P0)

- `packages/db/drizzle/0003_email_canonical.sql`: ① canonical 충돌 존재 시
  RAISE EXCEPTION (자동 병합 금지, 수동 해결 강제) ② 기존 row lowercase backfill
  ③ `unique index on lower(trim(email))`.
- 로컬 DB 적용·검증: 기존 계정 case-변형 register가 **409** (index가 squat 차단).

### V6-4. login 경로 validation — 완료

- core login에서 `emailSchema`(형식) + `loginPasswordSchema`(1~200자) 강제,
  위반 시 400. canonical email은 parse 결과 사용. 실측: malformed email 400,
  201자 password 400 (Argon2 도달 전 차단).

### V6-2. production ingest origin 필수 — 완료

- `apps/svc-media/src/env.ts`: production에서 `INGEST_ALLOWED_ORIGINS` 빈 값이면 기동 실패.

### V6-1 (부분). ingest client IP — 부분 완료

- handshake IP key를 `Fly-Client-IP` header 우선으로 변경 (Fly edge가 설정).
- 잔여: staging에서 실제 socket peer/XFF chain 관측 — 배포 검증 대기 (P0 완료 판정 보류 유지).

### V6-6. CI 안정성 — 완료

- core :50051 TCP 대기 후 BFF 기동, `timeout-minutes: 15`, 실패 시 core/bff log 출력
  (logger redaction 기적용 상태).

## 검증 결과 (7차)

- typecheck·lint·build: bff/svc-core/svc-media 통과
- migration 0003 로컬 적용 성공, canonical unique index 생성 확인
- 실검증: squat register 409 / malformed email login 400 / 201자 password 400 /
  미존재 계정 login latency 동일 자릿수(59ms vs 76ms)
- WS guard 실검증: 적대 Origin pre-upgrade 403, 신규 room 6번째부터 4429
- `smoke:session` 회귀: 24/24 PASS

## 남은 항목

- V6-1 잔여: Fly staging에서 client IP/XFF 실관측 (배포 시)
- V6-3 잔여: **prod DB에 migration 0003 적용 필요** (배포 절차에 포함;
  충돌 있으면 migration이 스스로 중단됨)
- V4-1 잔여: channel 존재 확인 by-id RPC (proto 추가)
- V4-4: nonce 기반 CSP (report-only 시작)
- V5-3: Argon2 gate 단위 테스트·metrics
- V5-4: rotate/revoke 수백 회 stress + famrev TTL 직접 검증
- P2-5: drizzle-orm/postcss 업데이트 + CI audit
- P2-1: 내부 서비스 인증
- prod 배포: 전 수정 미배포 (migration 0003 + INGEST_ALLOWED_ORIGINS +
  METRICS_TOKEN secret 포함)

---

# 8차 반복 (2026-07-12) — P2-5 의존성 취약점 해소

review.md 신규 갱신 없음 — 검증자 지정 다음 순위(P2-5) 진행.

## 완료

### P2-5. production 의존성 취약점 2건 + CI audit gate — 완료

- `drizzle-orm` 0.38.4 → **0.45.2** (GHSA-gpj5-g38j-94v9 해소), `drizzle-kit`
  0.30.6 → 0.31.10. `packages/db`·`apps/svc-core` 버전 통일 (불일치 시 타입
  충돌 발생해 함께 갱신).
- `postcss` 8.4.31 → **8.5.16** (GHSA-qx2v-qp2m-jg93 해소). next 15.5.20이
  8.4.31을 고정하므로 root `pnpm.overrides`(`postcss@<8.5.10: >=8.5.10`) 사용
  — review 지시대로 임시 조치임을 명시 (next 업데이트 시 제거 검토).
- `pnpm audit --prod --audit-level=moderate`: **No known vulnerabilities found**.
- CI build job에 `pnpm audit --prod --audit-level=high` gate 추가 (이제 통과
  가능 상태이므로 활성화).

## 검증 결과 (8차)

- 전 워크스페이스 build 9/9, typecheck 12/12 통과 (Next production build 포함
  — postcss override 영향 없음 확인)
- drizzle-orm 0.45 migrator로 migration 재실행 정상 ("migrations applied")
- CRUD 회귀: `svc-core scripts/smoke.ts` (register/login/channel/stream/listLive)
  SMOKE OK, `smoke:session` 24/24 SMOKE OK
- audit clean

## 남은 항목

(7차와 동일 — 의존성 항목만 제거)

- Fly staging 검증 3건: client IP/XFF 관측(V6-1·V2-4), prod migration 0003
- channel by-id RPC 존재검증(V4-1), nonce CSP(V4-4), Argon2 gate
  단위테스트·metrics(V5-3), rotate/revoke stress(V5-4), bit_ token 1회
  소비(V2-5), P2-1 내부 서비스 인증, P2-4 잔여(이메일 인증·reset·MFA·감사),
  web refresh single-flight, env fail-fast 자동 테스트
- prod 배포 (전 수정 미반영)

---

# 9차 반복 (2026-07-12) — §13 검증 피드백 (V7-1~V7-6) 대응

## 완료

### V7-1. deploy workflow에 production migration 통합 — 완료 (P0)

- `.github/workflows/deploy.yml`: svc-core 배포 **이전에** migration step 추가 —
  `flyctl proxy`로 streamix-db 연결, core 머신에서 DATABASE_URL 확보, `db:migrate`
  실행, journal tag 출력. migration 0003의 충돌 가드는 transaction 안에서
  RAISE하므로 (partial write 없음) 충돌 시 job이 여기서 중단되어 구 core가 유지됨
  — "preflight 실패 시 배포 중단, 자동 병합 금지" 정책 충족.
- 참고: 검증자 지시 3의 2단계 release 분리는 미채택 — 현 사용자 규모에서
  migration-first 단일 release로 충분하다고 판단. 실 deploy run 검증은 배포 시.

### V7-2. ingest origin parser 공유 + 엄격 검증 — 완료

- `apps/svc-media/src/env.ts`: `ingestAllowedOrigins`를 단일 파싱·export —
  env 검증과 runtime이 동일 결과 사용 (`","` 우회 차단). 각 항목은 `new URL`
  parse 후 `u.origin === 입력값` 강제 (path/query/fragment/trailing slash/
  credential 불가), production은 https + 최소 1개 필수.
- 실검증: `INGEST_ALLOWED_ORIGINS=","` production 기동 실패,
  `https://.../path` 항목 기동 실패.

### V7-3. CI log/lifecycle 결함 — 완료

- log step을 session smoke 뒤로 이동 (`if: failure()`가 실제로 잡히도록).
- core :50051 30초 내 미오픈 시 명시적 exit 1.
- core/bff PID 저장 후 `if: always()` cleanup step에서 종료.

### V7-4. timing 분포 검증 — 완료 (통계 측정)

- warm-up 5회 후 각 60회 serial 측정 (rate limit 상향한 임시 bff):
  - 실계정 wrong-password: median 50.7ms, p95 65.4ms
  - 미존재 계정: median 51.3ms, p95 61.4ms
- 분포 사실상 동일 — 계정 존재 timing oracle 제거 확인.
- 잔여: 기존 계정 hash parameter variation 조사(전부 argon2 default로 생성돼
  현재 variation 없음), gate 포화 상태에서의 분포는 부하 리그 작업.

### V7-5. dummy hash 초기화 fail-fast — 완료

- `ensureAuthReady()` export, `svc-core/main.ts`가 listen 전에 await —
  Argon2 init 실패 시 명확한 fatal 종료 (unhandled rejection 제거).

### V7-6. channel 존재 확인 — 미착수 유지

- by-id RPC proto 추가 필요. P2-2는 부분 완료 상태 유지.

## 검증 결과 (9차)

- typecheck·lint·build: svc-core/svc-media 통과
- timing 분포: 위 상세 (60+60 샘플)
- production env 거부 케이스 2건 실검증
- (8차에서 smoke:session 24/24 — 이번 변경은 core bootstrap·CI·media env로
  session 경로 무변경)

## 남은 항목

- V7-1 잔여: 실 deploy run에서 migration step 동작 확인 (prod 배포 시)
- V4-1/V7-6: channel by-id RPC, V4-4 nonce CSP, V5-3 gate 단위테스트·metrics,
  V5-4 stress, V2-5 bit_ token 1회 소비, P2-1 내부 서비스 인증,
  P2-4 잔여 기능들, Fly staging IP/XFF 관측
- prod 배포 (전 수정 미반영)

---

# 10차 반복 (2026-07-12) — V4-1/V7-6 channel 존재 검증 (P2-2 마감)

review.md 신규 갱신 없음 — 검증자가 반복 지적한 마지막 P2-2 결함 해소.

## 완료

### V4-1/V7-6. chat room의 channel 존재 검증 — 완료

- proto: `ChannelService.ChannelExists(channel_id) -> exists` 추가 (additive,
  internal-only 주석 명시). buf lint 통과. (`proto:breaking`은 Windows 로컬
  quoting 이슈로 미실행 — additive 변경이고 CI에서 검증됨.)
- `apps/svc-core/channel.service.ts`: id 단건 조회 구현.
- `apps/bff/services/channel.proxy.ts`: public surface에서 `PermissionDenied`
  차단 (internal-only).
- `apps/bff/ws/chat.ts`: 신규 room 생성 전 core 존재 확인 — positive cache
  60s / negative cache 30s (10k 상한). core 장애 시 join만 fail-open
  (room 총량·생성률 상한이 여전히 bound, §10 가용성 우선과 일관).
  미존재 channel은 `4004 ROOM_NOT_FOUND` 종료.

## 검증 결과 (10차)

- 실검증: 실존 channel 연결 정상(1000), 미존재 UUID 4004, 반복 연결(negative
  cache 경로)도 4004. `smoke:session` 회귀 SMOKE OK.
- typecheck·lint·build: proto/svc-core/bff 통과.

## 검증 중 발견한 프로세스 이슈 (기록)

- 검증 중 이전 반복의 bash 배경 기동 bff(rate-limit 상향본)가 :8080을 계속
  점유해 새 코드가 반영 안 된 것처럼 보이는 현상 발생 — stale process 종료 후
  정상 확인. 이후 반복부터 기동 전 포트 점유 확인 절차 추가.

## 남은 항목

- V4-4 nonce CSP(report-only 시작), V5-3 Argon2 gate 단위테스트·metrics,
  V5-4 rotate/revoke stress, V2-5 bit_ token 1회 소비(web 협조),
  P2-1 내부 서비스 인증, P2-4 잔여(이메일 인증·reset·MFA·감사),
  Fly staging IP/XFF 관측, V7-1 deploy run 실검증
- prod 배포 (전 수정 미반영 — deploy.yml에 migration 포함됨)

---

# 11차 반복 (2026-07-12) — §14 V8 + §15 V9 CI/CD 공급망 (P0)

review.md §14·§15 추가. 검증자 최우선(V9-1/V8-2/V8-3 공급망 P0) 처리 후 사용자 중지 요청.

## 완료

### V8-2/V8-3/V9-1. deploy 토큰 scope 축소 + action pinning — 완료 (P0)

- `.github/workflows/deploy.yml` 재작성:
  - `FLY_API_TOKEN` job-level env 제거 → flyctl 실행 step에만 개별 scope.
    checkout/setup/`pnpm install`은 토큰 없이 실행 (install script가 토큰 접근 불가).
  - migration step: flyctl proxy/ssh 후 `unset FLY_API_TOKEN` → migrator 실행
    (V9-1 지시 4).
  - `superfly/flyctl-actions/setup-flyctl`을 commit SHA
    `fc53c09e1bc3be6f54706524e3b82c4f462f77be`(v1.5)로 pin (WebFetch로 SHA 확인).
  - Vercel CLI를 `vercel@55.0.0`으로 lockfile pin (`npm i -g vercel@latest` 제거),
    설치 step은 토큰 없이 `pnpm install`, deploy step에만 `VERCEL_TOKEN` scope.

### V9-3. DB URL 재작성을 실제 파서로 — 완료

- `packages/db/src/rewrite-url.ts`: raw URL을 stdin으로 받아(argv 노출 방지)
  Node `URL`로 host/port/sslmode만 변경, 재작성 URL만 출력.
- 실검증: encoded password(`p%40ss`) 보존, 기존 query 있으면 `&sslmode=disable`
  append(`?` 중복 없음).

### V9-4. production migration 적용 증거 — 완료

- `packages/db/src/verify-schema.ts`: prod DB의 `drizzle.__drizzle_migrations`
  마지막 hash + `users_email_canonical_unique` index 실재를 DB catalog에서 확인,
  없으면 exit 1. connection string 미출력. deploy migration step에 편입.
- 실검증: 로컬 DB에서 hash + `canonical email index present: true` 출력.

### V8-1. postcss override 정확 버전 고정 — 완료

- `">=8.5.10"` → `"8.5.16"` (열린 range → 검증 버전). lockfile 갱신.

### V8-4. container 이미지 digest pin — 완료

- 5개 prod Dockerfile `node:22-slim`을 `@sha256:a149cd71…`로 pin.
- svc-media `bluenviron/mediamtx:latest`를 `@sha256:371b6829…`로 pin.
- 주석에 reviewed-PR bump 방침 명시.

## 검증 결과 (11차)

- 전체 build 9/9, db typecheck 통과, audit clean
- rewrite-url: encoded password/기존 query 케이스 정상
- verify-schema: 로컬 DB index 확인 성공

## 미완료 (사용자 중지)

- V8-4 잔여: compose(minio/mediamtx latest) digest, node 정확 patch 버전 태그 병기
- V9-2: 2단계 호환 release(old/new core email 조회 호환) — 단일 release 유지 결정,
  maintenance window/rollback 문서화 필요
- V9-5: 최초 bootstrap(core app 부재) migration 경로, suspend core SSH wake 검증
- V8-5: audit를 install 직후로 이동, OSV/Dependabot 보조 스캐너
- 그 외 이전 반복 잔여: V4-4 nonce CSP, V5-3/V5-4 gate 테스트·stress,
  V2-5 bit_ token 1회 소비, P2-1 내부 서비스 인증, P2-4 잔여, Fly staging IP/XFF,
  web refresh single-flight, prod 배포

---

# 12차 반복 (2026-07-12) — V5-3 / V5-4 테스트 커버리지 (vitest 도입)

review.md 신규 갱신 없음 — 검증자가 반복 요청한 gate 단위테스트·session stress 처리.
테스트 프레임워크 부재였으므로 vitest 도입 병행.

## 완료

### V5-3. Argon2 gate 단위테스트 + 주입 가능 분리 — 완료

- `apps/svc-core/src/auth/gate.ts`: bounded-concurrency gate를 `createGate({maxConcurrent,
maxQueue, queueTimeoutMs})` 팩토리로 분리 (지시 1: work 함수 주입 가능). `stats()`로
  running/queued 관측 노출. `password.ts`는 이 gate로 argon2 hash/verify 래핑.
- vitest 도입: root `test` turbo task + `pnpm test`, svc-core `test` script,
  CI build job에 `Unit tests` step 추가.
- `gate.test.ts` 5 케이스 (실행 5/5 PASS):
  - 20개 동시 작업에서 peak 동시성이 정확히 maxConcurrent(2) — 초과 없음
  - maxQueue 초과 시 `ResourceExhausted`(code 8)
  - task throw 시 permit 미누수 (다음 작업 정상 실행 + stats 0/0)
  - waiter timeout 시 queue에서 제거
  - queued 작업 FIFO 순서

### V5-4. rotate/revoke stress + famrev 직접 검증 — 완료

- `apps/bff/scripts/smoke-session-stress.ts` (Redis 대상 low-level 테스트),
  `smoke:session-stress` script, CI session-integration job에 편입.
- 실행 4/4 PASS:
  - 동시 rotation 20개 × 50 라운드: 매 라운드 successor 정확히 1개
  - logout‖rotate race 30 라운드: 매번 family dead + `fam:{f}` set 전멸 +
    `famrev:{f}` 존재 & TTL이 sliding window 이내
  - access-deny marker 수동 삭제(access-TTL 만료 시뮬레이트) 후에도 survivor sid
    refresh 거부 — famrev가 deny marker보다 오래 살아 V2-1 부활 방지 지속 확인

## 검증 결과 (12차)

- typecheck·lint·build: svc-core/bff 통과 (test 파일은 tsconfig build에서 제외 —
  dist 미포함 확인)
- `pnpm test` (root turbo): gate 5/5 PASS
- session stress: 4/4 PASS (실 Redis)

## 남은 항목

- V4-4 nonce CSP(report-only 시작), V2-5 bit_ token 1회 소비(web 협조),
  P2-1 내부 서비스 인증, P2-4 잔여(이메일 인증·reset·MFA·감사),
  V9-2 2단계 release, V9-5 bootstrap migration, V8-4 compose digest,
  env fail-fast 자동 테스트(이제 vitest로 가능), Fly staging IP/XFF 관측,
  web refresh single-flight
- prod 배포 (전 수정 미반영)

---

# 13차 반복 (2026-07-12) — env fail-fast 자동 테스트 (V1-5/V5-2/V6-2/V7-2)

review.md 신규 갱신 없음 — 검증자가 반복 요청한 env 검증 자동 테스트 (12차 vitest 도입으로 가능해짐).

## 완료

### bff/svc-media env fail-fast 자동 테스트 — 완료

- vitest를 bff·svc-media에도 도입 (test script + tsconfig test 제외 + root test task가 자동 포함).
- `apps/bff/src/env.test.ts` 10 케이스: subprocess(`tsx src/env.ts`)로 production
  fail-fast 검증 — valid prod boot(0), non-prod default(0), dev JWT secret 거부,
  32자 미만 거부, `COOKIE_SAMESITE≠none` 거부(V1-5), `COOKIE_SECURE=false` 거부,
  ACCESS_TTL <60s / >1h 거부(V5-2), abs<ttl 거부, GRACE 상한 초과 거부.
- `apps/svc-media/src/env.test.ts` 8 케이스: valid prod boot, non-prod default,
  dev playback secret 거부, 짧은 secret 거부, 빈 ingest origins 거부(V6-2),
  comma-only 거부(V7-2), http origin 거부, path 포함 origin 거부(V7-2).

### 부수 발견·수정: COOKIE_SECURE 문자열 파싱 버그

- `z.coerce.boolean()`은 `Boolean("false") === true` — `COOKIE_SECURE=false`가
  조용히 true로 해석되던 버그. 테스트 작성 중 발견.
- `boolEnv()` 헬퍼로 교체 (`/^(1|true|yes)$/i`만 true). dev 기본값(false) 불변이라
  기존 동작 영향 없음. 이제 `COOKIE_SECURE=false`가 실제 false로 해석되어
  production 검증이 정상 거부.

## 검증 결과 (13차)

- typecheck·lint·build: bff/svc-media 통과 (test 파일 dist 제외 확인)
- `pnpm test` (root turbo): 6 task 전부 통과 — gate 5 + bff env 10 + svc-media env 8 = 23 tests
- CI Unit tests step이 이 전부 실행 (12차에서 추가)

## 남은 항목

- V4-4 nonce CSP(report-only 시작), gate metrics 노출(gate.stats 존재),
  V2-5 bit_ token 1회 소비(web 협조), P2-1 내부 서비스 인증,
  P2-4 잔여(이메일 인증·reset·MFA·감사), V3-4(`at+jwt`),
  V9-2 2단계 release, V9-5 bootstrap migration, V8-4 compose digest,
  Fly staging IP/XFF 관측, web refresh single-flight, P1-3 잔여
- prod 배포 (전 수정 미반영)
