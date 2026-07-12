# [KICKOFF/종료] 보안 검토 대응 루프 — 세션 기록

> 실행 방식: `/loop 5m` — `inbox/review.md`(보안 감사) 갱신 감시 → 개선 구현 →
> `outbox/report.md` 기록 → prod 배포. 실행 주체: Fable 5 (medium effort).
> 상세 반복 로그는 [`outbox/report.md`](./outbox/report.md) (1~30차).
> 커밋 범위: `b9e3af0`(P0 시작) ~ `c606fcb`. 32 커밋. 전부 origin/main + prod 반영.

작업일: 2026-07-12. 상태: **완료·배포·검증**.

---

## 1. 범위

`inbox/review.md`의 정적 보안 감사(P0 3건·P1 5건·P2 5건) + 9차례에 걸친 작업 보고
검증 피드백(V1~V9, 총 40여 항목)을 반복 대응. 완료 판정 = 로컬 실검증 + prod
end-to-end 검증 + 배포 health.

## 2. 구현·배포 완료 항목

### P0 (인증 우회·세션 무결성)

- **P0-1** 구형 Connect Login/Refresh 우회 차단, jti 없는 access token 거부.
- **P0-2** refresh rotation을 Redis Lua 단일 원자 연산으로 — 동시 refresh 단일
  successor, 전 window tombstone, grace 내 idempotent.
- **P0-3** register/login IP 레이트리밋 + Redis 장애 시 fail-closed fallback.

### P1

- **P1-1** access token `fam` claim + family 단위 폐기(logout/reuse가 전 access
  token 무효화).
- **P1-2** production env fail-fast(dev secret·32자·쿠키 정책, 3서비스).
- **P1-3** URL credential 노출 제거: chat WS token→첫 frame 인증, browser ingest
  durable key 거부, HLS `Referrer-Policy: no-referrer`, 로그 redaction.
- **P1-4/P1-5** ingest pre-auth 자원 상한·handshake 검사, trusted proxy(XFF).

### P2

- **P2-1** 내부 서비스 토큰 인증(`x-internal-token` timing-safe, prod 강제).
- **P2-2** chat WS origin(pre-upgrade)·channel 존재 검증·socket/room 상한·heartbeat.
- **P2-3** 보안 헤더(CSP·HSTS·nosniff·Referrer·Permissions), `/metrics` 보호.
- **P2-4** email canonicalization(+migration 0003), 비밀번호 min12·취약 비밀번호
  차단·displayName 검증, 인증된 비밀번호 변경+전 세션 폐기, 감사 로그.
- **P2-5** drizzle-orm 0.45.2·postcss 8.5.16 취약점 해소 + CI audit gate.

### 검증 피드백 (V1~V9) 주요

- V2-1 logout/refresh race 부활 차단(`famrev` durable marker).
- V3-1 Argon2 동시성 gate를 svc-core로(256MiB OOM 방어).
- V4-4 nonce CSP report-only + 위반 리포트 수집.
- V5-1 login timing 계정 열거 방어(dummy Argon2).
- V5-3/V5-4 gate 단위테스트·session stress·metrics(vitest 도입).
- V6-3 email canonical migration, V6-4 login validation.
- V7-1 deploy migration gate, V8-2/3/V9-1 CI/CD 공급망(토큰 scope·action SHA pin·
  이미지 digest), V9-3/4 DB URL 파서·schema 검증.

### 관측성·CI

- BFF `/metrics`: WS 연결/room/reject·rate-limit·감사·CSP 위반 카운터.
- svc-core 내부 metrics(Argon2 gate depth/reject/latency).
- CI: unit test job(vitest), session-integration job, `pnpm audit` gate.

## 3. 프로덕션 배포 (19차~)

- **배포 순서**: 내부 토큰 rollout은 attacher(media,bff)→enforcer(chat,core),
  email canonical은 core 배포 후 migration.
- **엔드포인트**: web https://streamix-web.vercel.app · API https://streamix-bff.fly.dev
- **Fly(nrt)**: streamix-{svc-core,svc-chat,svc-media,bff} + db + redis-app.
- **prod 검증(28차)**: 보안 표면 end-to-end **20/20 PASS** — 헤더/CSP/metrics보호/
  connect차단, auth 라이프사이클+reuse탐지, logout/pw-change 폐기.

## 4. 배포 시 필수 주의

- **INTERNAL_TOKEN**: 4개 Fly 앱(core/chat/media/bff) 동일 값 유지. 불일치 시
  prod 내부 호출 전체 실패. 값은 Fly secret에만 존재(로컬 미저장).
- **INGEST_ALLOWED_ORIGINS**(svc-media), **COOKIE_SAMESITE=none/SECURE=true**(bff)
  production 필수.
- proto 변경(ChannelExists, ChangePassword) 포함 배포는 core+bff 동시 재배포.
- migration은 deploy.yml이 svc-core 배포 전 실행(0003 충돌 시 job 중단).
- GitHub Actions CD 토큰(FLY_API_TOKEN/VERCEL_TOKEN) 미설정 — 현재 수동 배포.

## 5. 미착수 잔여 (사용자 결정/신규 review 필요, 배포 블로커 아님)

- 이메일 인증·password reset → 이메일 provider 선택 필요.
- MFA/TOTP → 대형, prod lockout 방지 opt-in 설계 필요.
- V4-4 CSP enforce 전환 → 수집된 위반 리포트 관찰 후.
- P2-1 mTLS/짧은수명 service JWT → 공유 시크릿으로 1차 완료(marginal).
- V2-5 browser ingest token 1회 소비 → RTMP authz 재검증 구조 디커플 필요.
