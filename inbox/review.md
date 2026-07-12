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
