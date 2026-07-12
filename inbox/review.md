# Streamix 보안 검토 및 개선 방향

검토일: 2026-07-12

## 1. 범위와 결론

검토 범위:

- `README.md`, `KICKOFF.md`, `docs/*.md`, 작업계획서
- `apps/web`, `apps/bff`, `apps/svc-core`, `apps/svc-chat`, `apps/svc-media`
- `packages/db`, `packages/schemas`, proto 정의
- Fly, Docker Compose, MediaMTX, GitHub Actions 설정
- `pnpm audit --prod --audit-level=moderate`

코드 실행을 통한 침투 테스트는 하지 않았다. 아래 내용은 정적 코드·설정 감사 결과다.

현재 인증 설계의 방향은 좋다. access token을 메모리에만 저장하고, HttpOnly refresh cookie, Argon2id, 짧은 access token TTL, Redis 기반 회전·폐기를 사용한다. 그러나 구형 인증 RPC가 공개 BFF에 남아 있어 새 세션 모델을 완전히 우회할 수 있다. refresh 회전도 원자적이지 않고 재사용 탐지 기간이 60초뿐이다. 배포 전 P0 항목을 먼저 수정해야 한다.

## 2. 잘 적용된 보안 통제

- 브라우저 정상 경로의 access token은 Zustand 메모리에만 저장된다. `localStorage`에 인증 토큰을 저장하지 않는다.
- refresh credential은 `HttpOnly`, `/auth` 경로 cookie로 제한된다.
- 비밀번호는 `argon2` 기본 Argon2id로 해시되며 평문 비밀번호는 DB에 저장되지 않는다.
- 로그인 실패 응답은 계정 존재 여부를 구분하지 않는다.
- stream key는 24 random bytes 기반이며 DB에는 SHA-256 hash만 저장된다.
- HLS 서명 비교에 `timingSafeEqual`을 사용한다.
- BFF는 브라우저가 내부 채널 lifecycle RPC와 OAuth upsert RPC를 직접 호출하지 못하게 차단한다.
- Fly 설정상 core/chat 서비스는 public `http_service`를 열지 않는다.

## 3. 발견 사항

### P0-1. 구형 Connect Login/Refresh가 hardened 세션 모델을 우회함

근거:

- `apps/bff/src/main.ts:24-29`에서 `AuthService` 전체를 public Connect endpoint로 등록한다.
- `apps/bff/src/services/auth.proxy.ts:16-18`이 `login`과 `refresh`를 그대로 `svc-core`에 전달한다.
- `apps/svc-core/src/auth/auth.service.ts:42-56`은 stateless access/refresh JWT를 응답한다.
- `apps/svc-core/src/auth/jwt.ts:6-25`의 refresh JWT는 서버 저장·회전·재사용 탐지가 없다.
- `apps/bff/src/auth.ts:13-15`는 `jti` 없는 legacy access token을 허용하고 denylist 검사를 건너뛴다.
- `packages/proto/proto/user/v1/user.proto:31-44`가 refresh token을 public 응답 필드로 정의한다.

영향:

공격자나 일반 브라우저 호출자는 `/auth/login` 대신 Connect `Login`을 호출해 30일 stateless refresh JWT를 직접 얻을 수 있다. 이 토큰은 HttpOnly cookie 보호, 서버 측 폐기, refresh rotation, reuse detection을 모두 우회한다. 이 경로에서 발급된 access token에는 `jti`도 없어 logout denylist가 적용되지 않는다. `docs/auth-session.md`의 보안 보장이 실제 공개 API와 일치하지 않는다.

개선:

1. BFF public `authProxy`에서 `login`, `refresh`, 가능하면 `register`를 `PermissionDenied`로 차단한다. 브라우저 인증은 `/auth/register`, `/auth/login`, `/auth/refresh`만 허용한다.
2. 더 안전한 구조는 core가 브라우저용 token을 발급하지 않게 하는 것이다. core `Login`은 사용자 검증 결과만 BFF에 반환하고, token 발급·session 관리는 BFF 한 곳이 담당한다.
3. legacy programmatic caller가 필요하면 public BFF와 분리된 internal service 또는 별도 client-credential 인증 endpoint를 사용한다.
4. `jti` 없는 access token을 BFF에서 거부한다. issuer, audience, 허용 algorithm도 명시 검증한다.
5. 회귀 테스트: public Connect `Login/Refresh`가 token을 반환하지 않는지, legacy token이 `Me`에서 거부되는지 확인한다.

### P0-2. refresh rotation이 원자적이지 않고 재사용 탐지가 사실상 60초뿐임

근거:

- `apps/bff/src/session.ts:60-93`은 `HGETALL`로 상태를 읽은 후 별도 `MULTI`로 갱신한다. `WATCH`나 Lua compare-and-set이 없다.
- `apps/bff/src/session.ts:84-85`는 사용된 sid tombstone을 60초 후 삭제한다.
- `apps/bff/src/session.ts:71-73`은 60초 안 재사용을 즉시 family revoke한다. 주석의 “동시 refresh race 보호”와 반대로 동작한다.

영향:

동일 refresh token으로 동시에 두 요청을 보내면 둘 다 `used=0`을 읽고 각각 유효한 새 sid를 만들 수 있다. 탈취자와 정상 사용자가 동시에 회전하면 두 세션이 계속 살아남을 수 있다. 반대로 정상 클라이언트의 중복 요청은 family 전체를 폐기할 수 있다. 60초 후 탈취된 과거 token을 재사용하면 tombstone이 이미 없어 단순 `invalid`가 되므로 family 탈취 탐지가 발생하지 않는다.

개선:

1. 검증·used 전환·새 sid 생성·family 갱신 전체를 Redis Lua script 하나로 원자화한다.
2. used token tombstone을 최소 해당 family의 남은 절대 수명까지 유지한다. sid 원문 대신 SHA-256 hash를 key로 사용하면 Redis 유출 시 즉시 사용할 수 있는 token 노출도 줄어든다.
3. 동시 refresh 허용이 필요하면 짧은 grace 동안 이전 요청과 동일한 후속 session 결과를 idempotent하게 반환한다. grace 안 요청을 family 탈취로 처리해서는 안 된다.
4. 테스트: 20개 동시 refresh 중 하나만 새 session을 얻는지, 61초 이후 과거 sid 재사용도 family를 폐기하는지 검증한다.

### P0-3. 회원가입 endpoint에 rate limit이 없어 Argon2 자원 고갈 공격 가능

근거:

- `apps/bff/src/routes/auth.ts:32-44`의 REST register에는 rate limit이 없다.
- `apps/svc-core/src/auth/auth.service.ts:20-29`는 매 요청마다 DB insert 전에 Argon2 hash를 계산한다.
- `apps/bff/src/rate-limit.ts:23-35`의 Register 제한은 Connect interceptor에만 적용되므로 REST route에는 적용되지 않는다.

영향:

비인증 공격자가 서로 다른 이메일로 회원가입을 병렬 호출하면 CPU와 메모리를 많이 쓰는 Argon2 작업을 계속 발생시킬 수 있다. BFF와 core 가용성 저하 또는 비용 증가로 이어진다.

개선:

1. REST register에 IP 기반, IP subnet 기반, 전역 concurrency 기반 제한을 추가한다. 이메일 key만으로 제한하지 않는다.
2. 로그인에도 이메일 제한과 별도로 신뢰할 수 있는 client IP 기준 제한을 적용한다.
3. auth rate-limit Redis 장애 시에는 fail-closed 또는 작은 process-local fallback limit을 사용한다. 일반 조회 RPC와 동일한 fail-open 정책을 쓰지 않는다.
4. edge provider rate limit/WAF를 1차 방어로 추가하되 애플리케이션 제한을 유지한다.

### P1-1. logout/reuse detection이 이미 발급된 다른 access token을 폐기하지 못함

근거:

- `apps/bff/src/routes/auth.ts:82-89`는 logout 요청에 실린 현재 access token의 `jti` 하나만 denylist에 넣는다.
- `apps/bff/src/session.ts:51-57`의 family revoke는 refresh sid만 삭제한다.
- access token에는 session family 또는 session version 정보가 없다.

영향:

같은 session family에서 이전 refresh로 발급된 access token, 또는 공격자가 먼저 refresh해 확보한 access token은 victim logout이나 refresh 재사용 탐지 후에도 최대 15분간 유효하다. “logout이 유출 JWT를 즉시 폐기”한다는 문서 설명은 현재 token 하나에만 성립한다.

개선:

- access token에 `sid` 또는 family id를 넣고, family revoke 상태를 검증한다. 또는 사용자 `sessionVersion`/`revokedAfter`를 사용한다.
- family의 발급 `jti` 집합을 TTL과 함께 추적해 family revoke 시 모두 denylist 처리하는 방식도 가능하다.
- 비밀번호 변경, 계정 잠금, 관리자 강제 로그아웃에서 `revokeUser`와 access token 폐기를 함께 실행한다.

### P1-2. production secret·cookie 설정이 누락돼도 알려진 개발 기본값으로 기동함

근거:

- `apps/bff/src/env.ts:9`와 `apps/svc-core/src/env.ts:8`의 JWT 기본값은 `dev-insecure-secret-change-me`다.
- `apps/svc-core/src/env.ts:14`, `apps/svc-media/src/env.ts:10`의 playback 기본값도 알려져 있다.
- `apps/bff/src/env.ts:21-22`의 cookie 기본값은 split-origin production에 맞지 않는 `Lax`, `Secure=false`다.
- Fly 배포 설정은 `NODE_ENV=production`이지만 schema가 production 필수값을 강제하지 않는다.

영향:

배포 secret 설정 실수 시 서비스가 실패하지 않고 알려진 key로 기동한다. 공격자가 JWT 또는 HLS URL을 위조할 수 있다. cookie 설정 누락은 refresh 동작 실패와 OAuth state cookie 보호 약화로 이어진다.

개선:

- production에서는 `JWT_SECRET`, `PLAYBACK_SECRET`, `REDIS_URL`, `DATABASE_URL`, `CORS_ORIGINS`, `COOKIE_SAMESITE`, `COOKIE_SECURE`를 필수로 검증하고 개발 기본값이면 process를 종료한다.
- secret은 최소 32 random bytes를 요구한다.
- `COOKIE_SAMESITE=none`이면 `COOKIE_SECURE=true`를 명시적으로 요구한다.
- 장기적으로 core의 token 발급을 제거하고 BFF 전용 signing key를 사용한다. 서비스 간 key 공유 범위를 줄인다.

### P1-3. token과 stream credential이 URL query에 노출됨

근거:

- `apps/web/components/chat.tsx:26`은 access JWT를 `/ws?...&token=`에 넣는다.
- `apps/svc-media/src/ingest.ts:65-68`은 stream key/ingest token을 `/ingest?key=`에서 읽는다.
- `apps/svc-core/src/channel/channel.service.ts:278-282`는 HLS token을 query에 넣는다.
- `apps/bff/src/main.ts:15`는 Fastify 기본 request logger를 활성화한다.

영향:

URL은 reverse proxy, platform request log, 오류 추적, 브라우저 개발 도구에 기록될 수 있다. 특히 chat URL의 bearer access token과 durable stream key가 기록되면 계정·방송 탈취에 직접 사용될 수 있다.

개선:

- chat WebSocket은 연결 후 첫 frame으로 token을 보내고 인증 완료 전에는 room join/message를 금지한다. 또는 짧은 1회용 WS ticket을 HTTPS Authorization 요청으로 발급한다.
- browser ingest는 현재의 짧은 1회용 ingest token만 허용하고, 연결 후 즉시 원자적으로 소비한다. durable OBS stream key를 browser ingest에서 거부한다.
- logger와 platform 설정에서 query를 redaction한다. `authorization`, `cookie`, `set-cookie`도 함께 redaction한다.
- HLS query token은 플레이어 호환상 유지할 수 있지만 TTL 최소화, 로그 redaction, `Referrer-Policy: no-referrer`를 적용한다.

### P1-4. browser ingest가 인증 완료 전에 payload를 무제한 축적함

근거:

- `apps/svc-media/src/ingest.ts:73-90`은 core key 검증이 끝날 때까지 모든 chunk를 `pending` 배열에 저장한다.
- `INGEST_BUFFER_LIMIT_MB` 검사는 ffmpeg sink가 생긴 뒤 `writableLength`에만 적용된다.
- `WebSocketServer`에 `maxPayload`, 연결 수, handshake rate limit, origin 검사가 없다.

영향:

공격자가 invalid key 연결을 다수 열고 검증 응답 전 큰 frame을 전송하면 Node heap을 고갈시킬 수 있다. core 지연·장애 시 공격 창이 커진다.

개선:

- 인증 전 pending byte 합계를 별도 추적하고 작은 상한을 넘으면 즉시 종료한다.
- `WebSocketServer({ maxPayload })`를 실제 MediaRecorder chunk보다 약간 큰 값으로 설정한다.
- 연결/IP별 handshake 제한과 전체 동시 encoder 상한을 둔다.
- 가능하면 먼저 작은 auth message를 검증한 후 binary frame handler를 활성화한다.
- 허용 web origin을 검사한다. OBS RTMP 경로와 browser WebSocket 정책을 분리한다.

### P1-5. 사용자 제공 `x-forwarded-for`를 rate-limit identity로 신뢰할 수 있음

근거:

- `apps/bff/src/rate-limit.ts:38`이 `x-forwarded-for` 첫 값을 그대로 client IP로 사용한다.
- Fastify의 `trustProxy`가 명시되지 않았다.

영향:

edge proxy가 client 제공 header를 제거·정규화하지 않으면 공격자가 값을 바꿔 RPC IP 제한을 우회할 수 있다. REST login은 IP 제한 자체가 없어 credential stuffing 방어가 더 약하다.

개선:

- Fly proxy hop만 신뢰하도록 Fastify `trustProxy`를 제한하고 `req.ip`를 사용한다.
- 배포 환경에서 실제 `X-Forwarded-For` 체인을 확인하는 통합 테스트를 추가한다.
- 이메일은 trim·소문자 canonicalization 후 rate-limit key와 DB 조회에 동일하게 사용한다.

### P2-1. 내부 서비스가 신뢰 header만으로 권한을 부여함

근거:

- `apps/svc-core/src/auth/auth.service.ts:12-16`, `apps/svc-core/src/channel/channel.service.ts:99-102`, `apps/svc-chat/src/chat.service.ts:33-38`은 `x-user-id` 존재만 확인한다.
- 내부 gRPC는 h2c이며 서비스 token 또는 mTLS 검증이 없다.

영향:

현재 Fly private network가 1차 경계다. 같은 private network의 다른 app이 침해되거나 잘못 공개되면 임의 `x-user-id`로 사용자 impersonation, 채널 변경, 채팅 발송이 가능하다.

개선:

- BFF/media workload identity를 확인하는 mTLS 또는 짧은 수명의 service JWT를 사용한다.
- user context에는 호출 method·audience를 포함해 서명하고 각 서비스가 검증한다.
- private network와 firewall 제한은 계속 유지한다.

### P2-2. WebSocket origin·room 유효성·연결 자원 제한이 부족함

근거:

- `apps/bff/src/main.ts:41-44`와 `apps/bff/src/ws/chat.ts:124-145`는 `Origin`을 확인하지 않는다.
- 임의 `channelId`마다 Redis subscriber와 room map entry를 만든다.
- 사용자/IP별 동시 socket 수 제한이 없다.

영향:

유효 token을 가진 공격자가 많은 임의 room과 socket을 생성해 BFF file descriptor, Redis connection/subscription, 메모리를 소모할 수 있다. URL token 유출과 결합되면 cross-site 악용 가능성도 커진다.

개선:

- handshake에서 exact allowed origin을 검사한다.
- channel 존재 여부를 확인한 뒤 room을 만든다.
- 사용자/IP/instance별 동시 연결 수와 신규 room 생성률을 제한한다.
- idle timeout, ping/pong heartbeat, 최대 frame size를 설정한다.

### P2-3. 보안 header와 민감 endpoint 보호가 없음

근거:

- `apps/web/next.config.ts`에 CSP, HSTS, `X-Content-Type-Options`, frame 제한, referrer policy가 없다.
- `apps/bff/src/main.ts:34-39`의 `/metrics`가 인증 없이 public BFF에 노출된다.

영향:

XSS·clickjacking 방어 계층이 부족하다. `/metrics`는 process/runtime 정보를 외부에 노출하고 반복 scrape 대상이 될 수 있다.

개선:

- nonce 기반 CSP를 적용하고 `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`를 포함한다.
- HSTS, `nosniff`, `Referrer-Policy: no-referrer`, 필요한 범위의 `Permissions-Policy`를 설정한다. 카메라·마이크는 studio 기능을 깨지 않도록 self만 허용한다.
- `/metrics`는 private listener로 분리하거나 service authentication/IP allowlist를 적용한다.

### P2-4. 계정·입력 정책이 최소 수준임

근거:

- `packages/schemas/src/index.ts:9-15`는 비밀번호 길이 8~200만 검사한다.
- `apps/svc-core/src/auth/auth.service.ts:20-29`은 display name을 server-side schema로 검증하지 않는다.
- 이메일 canonicalization, 이메일 인증, 비밀번호 재설정, MFA, 보안 이벤트 감사 기능이 없다.

영향:

약한 비밀번호, 중복·혼란스러운 이메일 계정, 과도한 display name 저장이 가능하다. 계정 탈취 탐지·복구 수단도 부족하다.

개선:

- 비밀번호 최소 길이를 12 이상으로 올리고 최대 길이는 유지한다. 복잡도 규칙 대신 유출 비밀번호 차단과 password manager 허용을 우선한다.
- 이메일을 trim 후 도메인과 정책에 맞게 canonicalization하고 DB unique 정책과 일치시킨다.
- display name 길이, Unicode 제어문자, 줄바꿈을 server-side에서 검증한다.
- 이메일 인증, 안전한 password reset, 중요 계정 MFA/WebAuthn, 로그인·refresh reuse·logout 감사 로그를 단계적으로 추가한다.

### P2-5. production 의존성 취약점 2건

`pnpm audit --prod --audit-level=moderate` 결과:

- High: `drizzle-orm@0.38.4`, GHSA-gpj5-g38j-94v9, SQL identifier escaping 취약점. 수정 버전 `>=0.45.2`.
- Moderate: `postcss@8.4.31`, GHSA-qx2v-qp2m-jg93, CSS stringify의 `</style>` XSS. 수정 버전 `>=8.5.10`.

현재 DB query는 정적 schema identifier를 사용하므로 Drizzle 취약점의 직접 악용 경로는 확인하지 못했다. PostCSS도 runtime에 사용자 CSS를 stringify하는 경로는 확인하지 못했다. 따라서 advisory 심각도와 현재 프로젝트의 실질 도달 가능성을 구분해야 한다. 그래도 production dependency이므로 업데이트가 필요하다.

개선:

1. 별도 branch에서 `drizzle-orm`과 `drizzle-kit` 호환 버전을 함께 올리고 migration 생성·적용·CRUD 회귀 테스트를 수행한다.
2. Next/PostCSS dependency tree를 업데이트해 PostCSS `>=8.5.10`을 사용한다. lockfile override는 임시 조치로만 사용한다.
3. CI에 `pnpm audit --prod --audit-level=high` 또는 OSV/Dependabot 검사를 추가한다. moderate 항목은 정기 triage한다.

## 4. 권장 수정 순서

1. Public Connect `Login/Refresh` 차단. legacy `jti` 없는 JWT 거부.
2. Redis Lua 기반 refresh rotation과 장기 tombstone 구현.
3. REST register/login rate limit, auth 장애 시 local fallback 적용.
4. Production env fail-fast 검증.
5. access token을 family 단위로 폐기하도록 claim·denylist 모델 보완.
6. chat/ingest URL credential 제거와 log redaction.
7. ingest pre-auth buffer, WebSocket payload·연결·origin 제한.
8. trusted proxy 설정, 내부 서비스 인증, security header, metrics 보호.
9. 의존성 업데이트와 CI 보안 검사.
10. 이메일 인증·비밀번호 복구·MFA·감사 로그 같은 계정 보호 기능 추가.

## 5. 필수 회귀 테스트

- Public Connect `Login/Refresh` 차단 테스트.
- `jti`, `typ`, issuer, audience가 없거나 잘못된 JWT 거부 테스트.
- refresh token 동시 사용, 과거 token 재사용, family revoke, Redis 장애 테스트.
- logout·password change 후 동일 family의 모든 access token 거부 테스트.
- register/login IP·계정·전역 rate limit과 spoofed XFF 테스트.
- production 환경에서 개발 secret·잘못된 cookie 조합으로 기동 실패 테스트.
- chat/ingest 잘못된 origin, 과대 frame, 과다 연결, 임의 channel 테스트.
- 로그에 access token, refresh cookie, stream key, HLS token이 남지 않는지 검사.
- dependency 업데이트 후 migration, auth, channel, HLS, browser E2E 회귀 테스트.

## 6. 문서 정합성 수정 필요

`docs/auth-session.md`는 현재 구현보다 강한 보장을 서술한다. 특히 다음 문구는 P0/P1 수정 전 사실이 아니다.

- refresh token이 항상 opaque·server-side·rotating이라는 설명
- 사용된 refresh token 재사용 시 항상 family가 폐기된다는 설명
- logout이 유출 access JWT를 폐기한다는 설명
- 15/15 smoke 결과가 전체 공개 인증 surface를 보장한다는 인상

수정 완료 전에는 known limitation을 명시하고, 완료 후 public Connect surface와 동시성 테스트를 문서의 smoke 범위에 포함해야 한다.

## 7. 작업 보고 검증 — 1차 (2026-07-12 18:03 KST)

검증 대상: commit `b9e3af0` (`fix(security): p0 auth hardening from security review`), `outbox/report.md`

독립 확인 결과:

- `pnpm --filter @streamix/bff typecheck`: 통과
- `pnpm --filter @streamix/bff lint`: 통과
- `pnpm --filter @streamix/svc-core typecheck`: 통과
- `pnpm --filter @streamix/svc-media typecheck`: 통과
- 변경 범위는 인증·session·production env와 보고 문서로 제한되어 대체로 정당하다.
- public Connect credential RPC 차단, `jti` 필수화, Lua 원자 회전, register/login 제한, production fail-fast 방향은 기존 지시와 일치한다.

그러나 “P0 완료” 판정은 이르다. 다음 항목을 보완해야 한다.

### V1-1. 기존 session smoke가 새 grace 동작과 모순됨 — P0

근거:

- 새 `apps/bff/src/session.ts`는 사용된 sid를 60초 안 다시 제시하면 동일 successor를 `ok`로 반환한다.
- 기존 `apps/bff/scripts/smoke-session.ts:88-98`은 old sid를 즉시 재사용한 뒤 `401 reuse`와 family revoke를 기대한다.
- commit에는 이 테스트 수정이나 새 자동 테스트 파일이 없다. 보고서의 “Redis smoke 4/4”는 재실행 가능한 repository test로 남아 있지 않다.

영향:

기존 15/15 smoke를 실행하면 새 정책과 충돌해 실패해야 한다. 보고서가 기존 regression suite 상태를 정확히 반영하지 않는다.

지시:

1. `smoke-session.ts`를 새 정책에 맞게 갱신한다.
2. 동시 20개 refresh가 동일 successor를 받는지 자동 검증한다.
3. grace 안 재요청은 성공, grace 밖 재사용은 `reuse`, 이후 successor는 `invalid`인지 자동 검증한다.
4. 60초 실제 대기 대신 test clock 또는 설정 가능한 짧은 test grace를 사용한다.
5. ad-hoc smoke가 아니라 CI에서 재실행 가능한 test로 남긴다.

### V1-2. 60초 idempotent grace가 탈취 token에도 successor를 제공함 — P0

근거:

- Lua는 요청자·device·nonce를 구분하지 않고 old sid만 일치하면 60초 동안 successor sid를 반환한다.
- `/auth/refresh`는 그 successor를 새 HttpOnly cookie로 설정하고 access token도 새로 발급한다.

영향:

정상 refresh 직후 탈취된 old sid를 공격자가 60초 안 재사용하면 최신 session으로 승격된다. 동시 요청 오탐 방지와 탈취 탐지는 bearer token만으로 완전히 양립할 수 없다. 현재 60초는 공격 창으로 너무 길다.

지시:

- 우선 web client에서 refresh single-flight를 구현하고 server grace를 제거하는 방안을 검토한다.
- grace가 필요하면 수 초 수준으로 축소하고, successor sid 자체를 재전달하는 위험을 명시한다.
- 더 강한 보장이 필요하면 device-bound nonce/DPoP 계열 설계를 별도 검토한다. 단순 IP/User-Agent 결합은 이동망·proxy 때문에 인증 근거로 사용하지 않는다.

### V1-3. `req.ip` rate limit은 trusted proxy 설정 전 production 오동작 가능 — P0

근거:

- 새 `apps/bff/src/routes/auth.ts`는 register/login IP key로 `req.ip`를 사용한다.
- `apps/bff/src/main.ts:15`는 여전히 `Fastify({ logger: true })`이며 `trustProxy`가 없다.
- Fly proxy 뒤에서 socket peer가 proxy 주소라면 모든 사용자가 같은 rate-limit key를 공유한다.

영향:

기본 5회/30초 제한이 전체 서비스 공통 제한처럼 작동해 공격자 한 명이 모든 사용자의 회원가입·로그인을 막을 수 있다. 반대로 임의 XFF를 신뢰하도록 급히 바꾸면 제한 우회가 가능하다.

지시:

1. Fly의 실제 proxy chain을 확인하고 허용 hop/CIDR만 신뢰하도록 `trustProxy`를 제한한다.
2. 그 뒤 `req.ip`가 실제 client IP인지 production integration test로 확인한다.
3. 확인 전 P0-3을 완료 처리하지 않는다.
4. IP 제한 외에 endpoint 전체 concurrency 상한을 추가해 proxy 판별 실패 시에도 Argon2를 보호한다.

### V1-4. P0-1은 우회 차단은 완료했지만 JWT 검증 강화는 미완료 — P1

근거:

- `jti` 없는 token 거부는 구현됐다.
- `apps/bff/src/auth.ts`의 `jwtVerify(token, secret)`에는 허용 algorithm, issuer, audience 검증이 없다.
- public Connect `Register`까지 차단했지만 해당 차단을 검증하는 repository test가 없다.

지시:

- access token 발급 시 `iss`, `aud`, protected header `typ`을 설정한다.
- 검증 시 `algorithms: ["HS256"]`, issuer, audience를 강제한다.
- public Connect `Register/Login/Refresh`가 모두 `PermissionDenied`인지 자동 테스트한다.
- core의 stateless token RPC 제거 여부는 별도 구조 작업으로 유지한다.

### V1-5. production cookie 검증이 현재 split-origin 요구를 완전히 강제하지 않음 — P1

근거:

- 새 BFF 검증은 production에서 `COOKIE_SAMESITE`가 명시됐는지와 `COOKIE_SECURE=true`만 확인한다.
- `COOKIE_SAMESITE=strict` 또는 `lax`도 통과한다.
- 현재 배포 문서는 Vercel web과 Fly BFF의 cross-site 구성을 사용하므로 refresh cookie에는 `SameSite=None; Secure`가 필요하다.

영향:

안전하지 않은 cookie가 허용되는 문제는 줄었지만, `lax` 오설정으로 production login이 지속되지 않는 장애는 fail-fast하지 않는다.

지시:

- 현재 split-origin 배포를 유지하는 동안 production에서 `COOKIE_SAMESITE=none`을 강제한다.
- 또는 BFF를 web same-origin으로 proxy한 뒤 strict/lax를 허용하는 명시적 deployment mode를 둔다.
- env validation test를 추가해 개발 secret, 짧은 secret, `Secure=false`, 잘못된 SameSite 조합이 모두 기동 실패하는지 확인한다.

### V1-6. Lua session 저장 구조의 운영 한계 검증 필요 — P1

근거:

- used sid tombstone을 30일 유지하며 family set에도 모든 과거 sid가 누적된다.
- Redis script가 `refresh:*`, `fam:*`, `usess:*` key를 동적으로 접근한다.

위험:

15분마다 refresh하면 한 family에 최대 수천 개 tombstone이 쌓일 수 있다. 대규모 family revoke 시 Lua가 많은 key를 한 번에 삭제해 Redis event loop를 오래 점유할 수 있다. Redis Cluster 계열에서는 동적 multi-key script와 hash slot 제약도 확인해야 한다.

지시:

- 30일 지속 refresh 시 family당 key 수·memory와 revoke latency를 측정한다.
- 사용 중인 Fly/Upstash Redis topology에서 Lua multi-key 동작을 staging으로 검증한다.
- Cluster 가능성이 있으면 `{familyId}` hash tag 등 동일 slot key 설계를 검토한다.
- 대량 삭제는 `UNLINK` 또는 bounded batch 정리를 고려한다.

### 1차 판정

- P0-1: **부분 완료** — 공개 우회 차단·legacy token 거부 완료, claim 검증·회귀 테스트 미완료.
- P0-2: **부분 완료** — 원자 회전 구현, 기존 smoke 불일치·60초 탈취 창·운영 검증 미완료.
- P0-3: **부분 완료** — 제한 추가, trusted proxy·전역 concurrency 검증 미완료.
- P1-2: **부분 완료** — secret fail-fast 구현, split-origin SameSite 검증·자동 테스트 미완료.

다음 작업은 V1-1과 V1-3을 우선한다. 기존 테스트가 새 정책과 모순되고 production rate limit이 전체 로그인 장애를 만들 수 있기 때문이다.

## 8. 작업 보고 검증 — 2차 (2026-07-12 18:08 KST)

검증 대상: commit `eb6d93c` (`fix(security): p1 hardening — family-wide token revoke, ingest caps, trusted proxy`), 갱신된 `outbox/report.md`

독립 확인 결과:

- `pnpm --filter @streamix/bff typecheck`: 통과
- `pnpm --filter @streamix/bff lint`: 통과
- `pnpm --filter @streamix/svc-media typecheck`: 통과
- `pnpm --filter @streamix/svc-media lint`: 통과
- family claim과 deny marker, ingest pre-auth 8 MiB 상한, 16 MiB `maxPayload`, instance당 32 connection 상한은 기존 지시와 일치한다.
- `trustProxy: 1`과 오른쪽 XFF 선택은 단일 trusted proxy라는 전제가 실제 Fly 배포에서 확인될 때 유효하다.
- 보고서가 URL query credential 제거와 origin/handshake 제한을 “부분 완료/잔여”로 분류한 것은 정확하다.

다음 결함 때문에 P1-1 완료 판정은 보류한다.

### V2-1. logout/revoke와 refresh rotation race로 session family가 부활할 수 있음 — P0

근거:

- reuse/expired 경로의 Lua revoke는 원자적이지만, logout과 `revokeUser`가 사용하는 `apps/bff/src/session.ts`의 JS `revokeFamily`는 `SMEMBERS` 후 별도 `MULTI`를 실행한다.
- refresh rotation Lua는 family deny marker 존재 여부를 확인하지 않고 새 sid와 family set을 생성한다.
- 다음 순서가 가능하다.
  1. logout이 family의 기존 sid 목록을 읽는다.
  2. 동시에 refresh Lua가 새 sid를 만들고 family set에 추가한다.
  3. logout transaction이 이전 목록만 삭제하고 family set·deny marker를 설정한다.
  4. 또는 logout 삭제 직후 이미 시작된 rotation이 family set과 새 sid를 다시 만든다.
- 새 access token은 deny marker 때문에 당장은 거부되지만, marker TTL이 끝난 뒤 남은 refresh sid로 family가 다시 사용될 수 있다.

영향:

logout 또는 관리자 강제 로그아웃이 refresh credential을 영구 폐기한다는 보장이 깨진다. 공격자가 logout과 refresh를 경쟁시키면 최대 30일 session을 남길 수 있다.

지시:

1. `revokeSession`, `revokeUser`, rotate가 동일한 원자 상태를 기준으로 경쟁하도록 설계를 통합한다.
2. rotate Lua 시작 시 durable family revoked marker를 확인하고, 존재하면 새 sid를 만들지 않고 `invalid`를 반환한다.
3. revoke marker를 access TTL만 유지하는 marker와 refresh family 절대 수명까지 유지하는 marker로 분리한다. 전자는 access token 검증용, 후자는 refresh 부활 방지용이다.
4. family revoke 자체도 Lua로 원자화하거나 family generation/version compare-and-set을 사용한다.
5. 자동 race test: 동일 sid에 logout과 refresh를 수백 회 barrier 동시 실행한 뒤, 반환된 모든 sid가 즉시와 access deny TTL 이후에도 refresh 불가능한지 검증한다.

### V2-2. `ACCESS_TTL` parser 불일치가 family deny를 access token보다 먼저 만료시킬 수 있음 — P1

근거:

- `apps/bff/src/token.ts`의 `accessTtlSec()`는 정수와 `s`, `m`, `h`만 지원한다.
- `apps/bff/src/env.ts`는 `ACCESS_TTL`을 임의 문자열로 허용한다.
- `jose.setExpirationTime()`은 이 helper와 별도로 TTL을 해석한다.
- 지원하지 않는 값은 helper에서 조용히 900초로 fallback한다.

영향:

예를 들어 JWT library가 허용하는 더 긴 단위나 형식을 설정하면 access token은 15분보다 오래 살지만 family deny marker는 15분 후 사라질 수 있다. 폐기된 token이 다시 유효해진다.

지시:

- env schema에서 `ACCESS_TTL` 형식을 helper가 지원하는 형식으로 제한하고 최대값도 둔다.
- 더 안전하게는 token 발급 시 계산된 실제 `exp`를 기준으로 marker TTL을 산정한다.
- `15m`, `900s`, `1h`, 잘못된 값, 허용 최대 초과를 자동 테스트한다. 잘못된 값은 fallback하지 말고 기동 실패시킨다.

### V2-3. family revoke 검증이 재현 가능한 test로 남아 있지 않음 — P1

근거:

- 보고서는 Redis smoke 5/5를 주장하지만 commit에는 test 파일 변경이 없다.
- V1-1에서 지적한 기존 `smoke-session.ts`와 60초 grace 정책의 모순도 그대로다.

지시:

- family에 속한 여러 access token이 logout/reuse 직후 모두 거부되는 test를 repository에 추가한다.
- Redis 장애 시 fail-open이 의도대로 최대 access TTL로 제한되는지 test한다.
- “no-fam token 정상 동작”은 Redis 장애 시 BFF가 직접 발급한 token만 대상으로 제한한다. 임의 legacy token 허용으로 확대하지 않는다.
- 테스트가 commit과 CI에 없으면 완료 근거로 인정하지 않는다.

### V2-4. trusted proxy 완료 판정에는 Fly 실환경 증거가 필요함 — P1

근거:

- 구현은 proxy hop을 정확히 1개로 가정한다.
- 보고서에는 Fly에서 관측한 `req.ip`, socket peer, XFF chain 증거가 없다.

지시:

- staging에서 정상 요청과 client-supplied XFF 요청을 보내 실제 `req.ip`를 확인한다.
- 민감 IP 전체를 장기 log에 남기지 말고 일시 진단 또는 hash 처리한다.
- Fly 경로가 2개 이상 hop이면 숫자 `1` 대신 신뢰 proxy 함수/CIDR 정책을 사용한다.
- 확인 전에는 P1-5를 “구현 완료, 배포 검증 대기”로 표시한다.

### V2-5. ingest 상한은 부분 완료이며 upgrade flood는 남아 있음 — P1

근거:

- connection 수 검사는 WebSocket handshake가 수락된 뒤 `connection` handler에서 수행된다.
- IP별 handshake rate limit과 `Origin` 검사는 아직 없다.
- 고정 32개 상한은 수평 확장 시 instance마다 적용된다.

지시:

- `verifyClient` 또는 HTTP `upgrade` 단계에서 origin, IP rate, capacity를 검사해 handshake 전에 거부한다.
- valid ingest token은 WebSocket 연결 시 원자적으로 1회 소비한다. 검증만 하고 TTL 동안 반복 사용하게 두지 않는다.
- metrics에 현재 connection, pre-auth reject, payload reject, validation latency를 추가하되 public `/metrics`에는 노출하지 않는다.

### 2차 판정

- P1-1: **부분 완료** — family access deny 구현, logout/refresh race와 test 부재로 완료 불가.
- P1-4: **부분 완료** — memory 상한 구현, handshake/origin/IP/one-time token 미완료.
- P1-5: **배포 검증 대기** — 코드 전제는 합리적이나 Fly hop 증거 없음.
- P1-3: **부분 완료** — header redaction 완료, request URL query credential은 여전히 log 가능.

다음 최우선 작업은 V2-1이다. session 폐기의 핵심 보장을 직접 깨는 race이므로 다른 P1/P2 확장보다 먼저 해결해야 한다.

## 9. 작업 보고 검증 — 3차 (2026-07-12 18:18 KST)

검증 대상: commit `372acae` (`fix(security): v1 review feedback — grace 3s, jwt iss/aud, auth concurrency cap`), 갱신된 `outbox/report.md`

확인 결과:

- 60초 grace를 기본 3초로 줄인 변경은 탈취 승격 창을 줄인다.
- access JWT의 HS256, issuer, audience, protected `typ` 고정은 V1-4 지시를 충족한다.
- production `SameSite=None; Secure` 강제는 현재 split-origin 배포와 일치한다.
- `smoke-session.ts`가 grace, 20개 동시 refresh, grace 이후 reuse, family access revoke, public Connect 차단을 검사하도록 확장됐다.
- 독립 smoke 재실행은 현재 localhost BFF가 기동되지 않아 `ECONNREFUSED :8080`로 수행하지 못했다. 보고된 21/21 결과는 코드상 검사 항목과 일치하지만 이번 검증 환경에서 재현 확인하지 못했다.
- V2-1 logout/refresh race와 V2-2 access TTL parser 문제는 이 commit 범위에 포함되지 않았으며 계속 최우선 잔여 항목이다.

### V3-1. BFF의 Argon2 동시성 16은 core 256 MiB를 보호하기에 너무 큼 — P0

근거:

- `apps/bff/src/routes/auth.ts`의 `MAX_INFLIGHT_AUTH`는 16이다.
- Argon2 기본 memory cost는 작업당 약 64 MiB다.
- `apps/svc-core/fly.toml`의 memory는 256 MiB다.
- 제한이 BFF process에 있어 BFF instance가 여러 개면 각 instance가 16개씩 core에 전달할 수 있다.
- core의 internal RPC를 직접 호출할 수 있는 다른 workload에는 이 제한이 적용되지 않는다.

영향:

단일 BFF에서도 이론상 Argon2 memory만 약 1 GiB에 이르러 256 MiB core가 OOM될 수 있다. “전역 상한 16이 Argon2 CPU를 보호한다”는 보고는 현재 resource 크기에서는 성립하지 않는다.

지시:

1. 실제 Argon2 연산이 실행되는 `svc-core`에 process-wide semaphore/queue를 둔다. register hash와 login verify 모두 포함한다.
2. 256 MiB 환경에서는 우선 2개 수준에서 시작하고 부하 측정으로 결정한다. Node·DB client·runtime 여유 memory를 남긴다.
3. queue 길이와 대기 timeout을 제한하고 초과 시 `ResourceExhausted`를 반환한다.
4. BFF 제한은 빠른 edge rejection 용도로 유지할 수 있으나 core 제한의 대체가 아니다.
5. 32개 이상 동시 register/login 부하에서 core RSS, event-loop delay, latency, reject 비율, OOM 여부를 측정한다.

### V3-2. `REFRESH_GRACE_MS`가 무제한 설정 가능 — P1

근거:

- `apps/bff/src/env.ts`는 `z.coerce.number().default(3000)`만 적용한다.
- 음수, 소수, 매우 큰 값에 대한 정수·범위 검증이 없다.

영향:

배포 오설정으로 grace를 다시 수 분·수 시간으로 늘리면 old sid 탈취자가 successor를 얻는 창이 재발한다.

지시:

- `int().min(0).max(5000)`처럼 코드가 허용할 안전한 상한을 schema에서 강제한다.
- production 권장값은 client single-flight 적용 전 1~3초로 제한한다.
- 음수, NaN, 5000 초과가 기동 실패하는 env test를 추가한다.

### V3-3. smoke는 repository 파일이지만 자동 gate는 아님 — P1

근거:

- `apps/bff/package.json`에 session smoke script가 없다.
- CI는 Postgres·Redis·svc-core·BFF를 기동해 이 smoke를 실행하지 않는다.
- 수동 실행에는 여러 service와 일치하는 `REFRESH_GRACE_MS` 설정이 필요하다.

지시:

- `smoke:session` script와 service orchestration 절차를 추가한다.
- CI integration job에서 격리 DB/Redis를 기동하고 smoke를 실행한다.
- 실패 시 각 service를 확실히 종료하고 test data를 격리한다.
- 장기적으로 time injection이 가능한 test framework로 옮겨 실제 sleep 의존을 제거한다.

### V3-4. protected JWT type 의미를 access token 용도로 더 명확히 할 수 있음 — P2

현재 protected header는 일반 `typ=JWT`, payload는 `typ=access`다. 보안 결함은 아니며 issuer/audience/algorithm 검증으로 token confusion 위험은 줄었다. 추후 표준화 시 access token protected type을 `at+jwt`로 사용하고 검증 시 protected header type도 명시 확인하면 목적이 더 명확하다. 우선순위는 V2-1, V2-2, V3-1보다 낮다.

### 3차 판정

- V1-1: **구현 완료, 독립 실행 확인 대기** — test 확장됨. 이번 회차는 BFF 미기동으로 재실행 불가.
- V1-2: **부분 완료** — 기본 grace 축소, schema 상한·client single-flight 미완료.
- V1-3: **부분 완료** — BFF 상한 추가, 값·적용 계층이 core resource를 보호하지 못함.
- V1-4: **완료** — issuer/audience/algorithm 검증과 Connect 차단 test 추가.
- V1-5: **구현 완료, env 자동 test 대기**.
- V1-6: **부분 완료** — `UNLINK` 적용, memory/topology 측정 미완료.

다음 순서: V2-1 logout/refresh 원자화 → V2-2 TTL 형식 강제 → V3-1 core Argon2 semaphore → CI session integration test.

## 10. 작업 보고 검증 — 4차 (2026-07-12 18:23 KST)

검증 대상: commit `25e1379` (`fix(security): p2 hardening — ws guards, security headers, metrics auth, docs`), 갱신된 `outbox/report.md`

확인 결과:

- hostile browser Origin 거부, 사용자·instance socket 상한, ping/pong 정리, metrics 인증/production 404, 기본 보안 header 추가 방향은 타당하다.
- UUID 형식 검사는 비정상 Redis key 문자열을 줄이지만 channel 존재 여부를 증명하지 않는다.
- CSP는 clickjacking/object/base 방어만 제공하며 XSS script 실행 정책은 아직 없다. 보고서도 nonce 기반 `script-src`를 보류했다고 명시한다.
- `docs/auth-session.md`의 issuer/audience, public Connect 차단, grace limitation 설명은 구현과 대체로 일치한다. 단 family revoke 절대 보장은 V2-1 race 해결 전 과장되어 있다.

### V4-1. 유효 형식의 임의 UUID로 room·Redis subscription 고갈 가능 — P1

근거:

- `apps/bff/src/ws/chat.ts`는 `UUID_RE`만 통과하면 `joinRoom(channelId)`를 호출한다.
- `joinRoom`은 channel이 DB에 존재하는지 확인하지 않고 UUID마다 subscriber, room map, Redis subscription을 만든다.
- 공격자는 무작위 UUID를 무제한 생성할 수 있다.
- 사용자 socket 상한은 10개지만 다수 계정·token 또는 반복 연결로 계속 새 room을 만들 수 있다. 빈 room은 socket close 시 정리되지만 연결 동안 resource를 점유한다.

지시:

1. room 생성 전 core에서 channel 존재 여부를 확인한다. hot path 비용을 줄이려면 짧은 TTL cache를 사용하되 negative cache도 둔다.
2. 사용자/IP별 “새 room 생성률”을 제한한다. 단순 socket 수 제한과 분리한다.
3. instance당 room 수 상한을 두고 초과 시 기존 room 가입만 허용하거나 새 room을 거부한다.
4. 자동 test: 유효 형식의 존재하지 않는 UUID 1,000개로 room/subscriber 수가 증가하지 않는지 확인한다.

### V4-2. Origin 검사는 WebSocket handshake 이후 실행됨 — P1

근거:

- `apps/bff/src/main.ts`의 `/ws` websocket route callback은 upgrade가 수락된 후 socket을 전달받는다.
- 현재 구현은 이 callback에서 `socket.close(4403)`를 호출한다.
- 보고서는 “handshake에서 Origin 검사”라고 표현하지만 HTTP upgrade 자체를 403으로 거부하지 않는다.

영향:

허용되지 않은 요청도 WebSocket handshake와 socket allocation 비용을 발생시킨다. 대량 cross-origin 연결 flood의 edge 비용을 줄이지 못한다.

지시:

- `@fastify/websocket`의 `preValidation`/route hook 또는 HTTP upgrade 단계에서 Origin을 검사해 upgrade 전에 403으로 거부한다.
- browser endpoint 정책상 Origin 없는 요청을 허용해야 하는지 재검토한다. smoke/운영 bot은 별도 internal endpoint 또는 명시적 service credential을 사용할 수 있다.
- 허용 Origin exact match, 유사 domain, `null`, 누락 Origin을 자동 test한다.

### V4-3. 인증 대기 중 socket은 전체 상한에 포함되지 않음 — P1

근거:

- `totalSockets` 증가는 `verifyAccessToken()`의 비동기 JWT·Redis 검증이 끝난 뒤 수행된다.
- 공격자가 다수 connection을 동시에 열면 검증 대기 상태 socket은 `MAX_TOTAL_SOCKETS`에 계산되지 않는다.

지시:

- upgrade 직후 또는 그 전에 pending+authenticated 전체 connection counter를 먼저 확보한다.
- 인증 성공 후 사용자 counter로 이동하고 모든 실패·예외·close 경로에서 정확히 감소시킨다.
- token 검증 timeout과 handshake/IP rate limit을 추가한다.

### V4-4. P2-3 security header는 부분 완료 — P2

근거:

- CSP에 `default-src`, `script-src`, `connect-src`, `img-src`, `style-src`가 없다.
- 현재 CSP는 inline/script injection 실행을 제한하지 않는다.

지시:

- 현재 resource 목록을 관찰한 뒤 report-only CSP부터 적용한다.
- Next middleware에서 per-request nonce를 만들고 framework script에 전달한 뒤 nonce 기반 `script-src`를 enforce한다.
- BFF/WS/media origin을 정확히 열어 주는 `connect-src`, 필요한 image/font/style source를 최소화한다.
- CSP violation reporting에는 token/query URL이 유출되지 않도록 endpoint와 report sample을 점검한다.

### V4-5. 인증 문서가 logout/revoke 보장을 과장함 — P1

근거:

- 갱신 문서는 family revoke가 해당 family의 모든 access token과 refresh rotation을 종료한다고 단정한다.
- V2-1에서 확인한 JS logout/revoke와 Lua rotate race는 아직 해결되지 않았다.
- `deny:fam` marker는 access TTL 후 사라지고, race로 남은 refresh sid는 그 뒤 다시 token을 발급할 수 있다.

지시:

- V2-1 수정 전 문서에 concurrent logout/refresh known limitation을 명시한다.
- 수정 완료 후 race test 결과를 근거로 제한 문구를 제거한다.

### 4차 판정

- P2-2: **부분 완료** — 기본 socket 상한·heartbeat 구현, channel 존재 검증·pre-upgrade Origin·pending 상한 미완료.
- P2-3: **부분 완료** — metrics 보호와 clickjacking header 완료, XSS 방어 CSP 미완료.
- 문서 정합성: **부분 완료** — 현 구현 설명 갱신, V2-1 race 누락.

다음 우선순위는 여전히 V2-1과 V3-1이다. 그 후 V4-1/V4-2로 WebSocket resource 경계를 완성한다.

## 11. 작업 보고 검증 — 5차 (2026-07-12 18:28 KST)

검증 대상: commit `95a1b88` (`fix(security): v2/v3 feedback — atomic family revoke, core argon2 gate`), 갱신된 `outbox/report.md`

독립 확인 결과:

- `pnpm --filter @streamix/bff typecheck`: 통과
- `pnpm --filter @streamix/bff lint`: 통과
- `pnpm --filter @streamix/svc-core typecheck`: 통과
- `pnpm --filter @streamix/svc-core lint`: 통과
- rotate와 revoke가 모두 Redis Lua 단위로 실행되고 rotate 시작 시 durable `famrev`를 검사하므로 V2-1 race의 핵심 interleaving은 제거됐다.
- access deny marker와 refresh resurrection marker를 분리한 설계는 목적과 TTL 차이를 정확히 반영한다.
- `ACCESS_TTL` 형식과 최대 1시간 제한, grace 최대 5초 제한은 기존 지시를 충족한다.
- Argon2 gate가 hash와 verify 실제 실행 지점에 적용되고 동시 2개·queue 32·timeout 5초로 제한된 것은 현재 256 MiB core에 합리적인 초기값이다.
- 보고된 smoke 24/24는 이번 회차에 service가 기동되어 있지 않아 독립 재실행하지 못했다. 정적 코드와 추가 test 항목은 보고 내용과 일치한다.

### V5-1. 로그인 timing으로 계정 존재 여부를 추정할 수 있음 — P1

근거:

- `apps/svc-core/src/auth/auth.service.ts:36-41`은 사용자가 없거나 OAuth-only 계정이면 Argon2 verify를 수행하지 않고 즉시 실패한다.
- password hash가 있는 실제 계정만 `verifyPassword`를 거쳐 비싼 Argon2 연산과 queue 대기를 수행한다.
- 응답 message는 동일하지만 latency 분포가 크게 다르다. 새 core gate가 포화될수록 차이가 더 뚜렷해질 수 있다.

영향:

공격자가 반복 측정으로 가입 이메일 또는 password 로그인 가능 계정을 열거할 수 있다. 이후 credential stuffing·피싱 대상 선정에 사용될 수 있다.

지시:

1. 존재하지 않는 사용자와 OAuth-only 사용자도 미리 생성한 dummy Argon2 hash를 동일 gate 안에서 verify한다.
2. dummy hash를 요청마다 새로 생성하지 않는다. 코드에 고정한 안전한 Argon2 encoded hash 또는 기동 시 1회 생성한 값을 사용한다.
3. 실제 계정·미존재 계정·OAuth-only 계정의 성공/실패 경로가 동일한 queue와 Argon2 비용을 사용하도록 한다.
4. 수백 회 latency 분포를 비교해 통계적으로 쉽게 구분되지 않는지 검증한다. 인위적 고정 sleep만으로 보정하지 않는다.

### V5-2. session 관련 숫자 env의 범위 검증이 부족함 — P1

근거:

- `REFRESH_TTL_DAYS`, `REFRESH_ABS_MAX_DAYS`는 `z.coerce.number()`만 사용한다.
- 0, 음수, 소수, 과도한 값에 대한 검증이 없다.
- Redis `EXPIRE`/`EX`는 정수 초와 양수 TTL을 요구하며 잘못된 값은 transaction/script 오류 또는 즉시 만료를 만들 수 있다.
- 새 `ACCESS_TTL` schema도 `0s`, `0m`, `0h`를 허용한다. revoke marker에서 `EX 0`은 오류다.

영향:

오설정 시 refresh key가 부분 생성되거나 만료되지 않거나 login이 access-only로 조용히 degrade될 수 있다. revoke Lua가 marker 설정 중 오류를 내면 logout 보장도 불명확해진다.

지시:

- `ACCESS_TTL` 계산 결과에 최소값을 둔다. 예: 60초 이상, 3600초 이하.
- refresh TTL·absolute max는 양의 정수로 제한하고 현실적인 최대값을 둔다.
- `REFRESH_ABS_MAX_DAYS >= REFRESH_TTL_DAYS` 관계를 `superRefine`으로 검증한다.
- 0, 음수, 소수, Infinity, 최대 초과, sliding>absolute 조합이 기동 실패하는 test를 추가한다.

### V5-3. Argon2 semaphore 자체의 자동 검증과 관측성이 없음 — P1

근거:

- gate 로직은 새로 추가됐지만 최대 동시 실행, queue overflow, timeout, permit 반환을 검증하는 test가 없다.
- 현재 상수와 queue 상태를 관측할 metric이 없다.

지시:

1. Argon 함수 또는 작업 callback을 주입 가능한 작은 gate 단위로 분리해 동시에 실행되는 작업이 절대 2개를 넘지 않는지 test한다.
2. 작업 성공·throw·timeout 후 permit leak가 없는지 test한다.
3. 33개 이상 waiter에서 `ResourceExhausted`, FIFO 처리, timeout waiter 제거를 검증한다.
4. production metric에 running, queue depth, timeout/reject count, Argon latency를 추가하고 protected metrics endpoint로만 수집한다.
5. 실제 32개 부하에서 core RSS와 OOM 여부를 측정하기 전 V3-1을 “구현 완료, 용량 검증 대기”로 유지한다.

### V5-4. race smoke 강도를 높이고 durable marker를 직접 검증할 필요 — P2

근거:

- race smoke는 3회이며 refresh와 logout을 `Promise.all`로 시작하지만 두 요청이 critical section에 도달하도록 barrier를 제공하지 않는다.
- 즉시 후속 refresh 401만 확인하며 `famrev`의 존재와 TTL은 직접 확인하지 않는다.

지시:

- lower-level session test에서 수백 회 동시 rotate/revoke를 실행한다.
- 각 결과에서 family set·모든 sid 삭제, `famrev` 존재, TTL 범위를 확인한다.
- access deny marker를 제거하거나 access TTL이 지난 상황을 test clock으로 진행한 뒤에도 refresh가 거부되는지 검증한다.

### 5차 판정

- V2-1: **구현 완료, stress/운영 검증 대기**.
- V2-2: **부분 완료** — 형식·최대값 완료, 0 최소값 미검증.
- V3-1: **구현 완료, 부하·단위 test 대기**.
- V3-2: **완료**.
- V3-3: **부분 완료** — package script 추가, CI orchestration 미완료.

핵심 session race 수정이 완료됐으므로 다음 검사는 V5-1 계정 timing, V4 WebSocket 잔여 항목, P2-5 dependency/CI 순서로 확장한다.

## 12. 작업 보고 검증 — 6차 (2026-07-12 18:38 KST)

검증 대상: commit `998b768` (`feat(security): ci session gate, ingest handshake guards, account policy`), 갱신된 `outbox/report.md`

독립 확인 결과:

- schemas, svc-core, svc-media, BFF typecheck 통과.
- CI가 Postgres·Redis service를 기동하고 migration, core/BFF, session smoke를 실행하는 구조는 V3-3 지시와 일치한다.
- ingest `verifyClient`가 upgrade 전 capacity·origin·rate를 검사하는 방향은 맞다.
- register email/password/display name의 server-side 검증과 Zod 오류의 400 mapping은 적절하다.
- 아래 배포·데이터 정합성 문제 때문에 ingest와 account policy 완료 판정은 보류한다.

### V6-1. ingest IP 제한이 Fly proxy 전체를 하나의 IP로 볼 수 있음 — P0

근거:

- `apps/svc-media/src/ingest.ts`의 handshake key는 `req.socket.remoteAddress`다.
- production HLS/ingest HTTP는 `apps/svc-media/fly.toml`의 Fly `http_service` 뒤에 있다.
- proxy 뒤 socket peer는 실제 browser가 아니라 Fly proxy일 수 있다.
- BFF에서 이미 같은 문제 때문에 trusted proxy/XFF 처리를 별도로 추가했다.

영향:

모든 browser ingest가 같은 proxy IP로 집계되면 전체 서비스에서 10회/분 이후 방송 연결이 거부된다. 공격자 한 명이 reconnect 10회로 다른 사용자의 방송 시작을 막을 수 있다.

지시:

1. Fly staging에서 socket peer와 전체 XFF chain을 실제 관측한다.
2. 신뢰 가능한 Fly hop만 제거해 client IP를 계산한다. client가 넣은 XFF 첫 값을 무조건 신뢰하지 않는다.
3. production topology 확인 전 `HANDSHAKES_PER_MIN`을 client IP 제한으로 간주하지 않는다.
4. spoofed XFF와 다수 실제 client IP integration test를 추가한다.

### V6-2. production에서 ingest origin allowlist가 비어 있어도 기동함 — P1

근거:

- `INGEST_ALLOWED_ORIGINS` 기본값은 빈 문자열이다.
- production fail-fast 검증이 없다.
- Fly config와 배포 문서에도 값이 추가되지 않았다.
- 빈 값이면 모든 Origin이 허용된다.

지시:

- browser ingest를 제공하는 production에서는 allowlist를 필수로 강제한다.
- Fly secret/env와 `docs/DEPLOY.md`에 정확한 Vercel production Origin을 추가한다.
- preview domain을 wildcard string 비교로 열지 말고 명시 목록 또는 검증된 suffix 정책을 사용한다.
- 누락·빈 값·host 유사 문자열이 production 기동/test에서 거부되는지 확인한다.

### V6-3. DB migration 없이 email canonicalization을 적용해 기존 계정 충돌 가능 — P0

근거:

- 기존 DB unique constraint는 case-sensitive `users.email` text unique다.
- 새 register는 trim+lowercase 값을 저장하지만 기존 row를 변환하는 migration이 없다.
- 기존 DB에는 `User@Example.com`과 같은 mixed-case row가 존재할 수 있다.
- 새 사용자가 `user@example.com`을 등록하면 DB unique를 통과해 의미상 같은 이메일의 두 계정이 생길 수 있다.
- login은 canonical row를 먼저 선택하므로 이후 기존 사용자가 정확한 mixed-case email을 입력해도 lowercase 신규 row가 먼저 조회되어 기존 계정 login이 막힐 수 있다.

영향:

기존 이메일의 lowercase 형태를 선점해 계정 혼동·로그인 거부를 일으킬 수 있다. 이메일 인증·password reset이 추가되면 더 직접적인 account takeover 경계 문제가 된다.

지시:

1. production data에서 `lower(trim(email))` 충돌을 먼저 조사한다. 충돌 row는 자동 병합하지 말고 수동 정책으로 해결한다.
2. 충돌 정리 후 기존 이메일을 canonical form으로 backfill한다.
3. DB에서 canonical uniqueness를 강제한다. PostgreSQL `citext` 또는 `unique index on lower(trim(email))` 중 한 정책을 선택한다.
4. application canonicalization과 DB constraint를 같은 migration release에 배포한다.
5. mixed-case legacy row, 의미상 중복 register, 기존 계정 login 회귀 test를 추가한다.

### V6-4. login password 길이 schema가 실제 인증 경로에 적용되지 않음 — P1

근거:

- `packages/schemas`에 `loginPasswordSchema`와 `loginSchema`를 정의했다.
- `apps/svc-core/src/auth/auth.service.ts` login은 이를 import하거나 호출하지 않는다.
- REST BFF login도 body를 직접 읽어 core로 전달한다.

영향:

보고서의 “login은 1~200자” 정책이 실제로 강제되지 않는다. Fastify body limit까지 큰 password가 Argon2 verify로 전달돼 불필요한 CPU·memory 복사 비용을 만들 수 있다.

지시:

- core login에서 `loginSchema.safeParse` 또는 email/password schema를 모두 적용하고 validation 오류를 400으로 mapping한다.
- canonical email은 parse 결과를 직접 사용한다.
- 빈 값, 201자 이상, 잘못된 email, legacy 8~11자 password login을 test한다.

### V6-5. account timing 열거 문제는 여전히 남아 있음 — P1

V5-1의 dummy Argon2 검증이 이번 commit에 포함되지 않았다. 미존재·OAuth-only 계정은 여전히 Argon2를 생략한다. account policy 완료 전 V5-1을 함께 해결해야 한다.

### V6-6. CI integration job의 startup 안정성 개선 — P2

현재 core와 BFF를 동시에 background 실행하고 BFF `/health`만 기다린다. BFF health는 core readiness를 확인하지 않는다. 느린 runner에서는 smoke 첫 register가 core startup과 경쟁할 수 있다.

지시:

- core port/RPC readiness를 먼저 확인한 뒤 BFF를 시작하거나 smoke에 bounded retry를 둔다.
- 실패 시 core/BFF log를 artifact 또는 step output으로 남긴다. credential header/query는 redaction한다.
- job timeout을 명시해 background process hang을 제한한다.

### 6차 판정

- V3-3: **구현 완료, CI 실제 run 확인 대기**.
- V2-5 handshake: **부분 완료** — pre-upgrade 검사 구현, client IP·production allowlist 미완료.
- P2-4 account policy: **부분 완료** — 입력 schema 추가, DB migration·login 적용·timing 방어 미완료.

다음 우선순위: V6-3 email migration/constraint → V5-1 timing 방어와 V6-4 login validation → V6-1 Fly client IP 검증 → P2-5 dependency update.
