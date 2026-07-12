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

## 남은 항목 (다음 반복 대상)

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
