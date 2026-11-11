# Plan 005: DB 실패 시 방송 라이브 점유 회수

> 시작 전 `git diff abea6eb..HEAD -- apps/svc-core/src/channel/channel.service.ts apps/svc-core/src/channel`로 드리프트를 확인한다. `startStream`/`heartbeat`의 점유 프로토콜이 바뀌었다면 중단한다.

## 상태

- 우선순위: P2 · 노력: S · 수정 위험: 중간 · 의존: 없음
- 범주: bug · 계획 기준: `abea6eb`, 2026-09-27

## 이유와 현재 상태

`apps/svc-core/src/channel/channel.service.ts:244`는 Redis `SET NX`로 `live:{channelId}`를 먼저 점유하고, `:248`에서 DB의 `streams` 행을 만든다. DB insert가 실패해도 Redis 키는 남는다. `apps/svc-core/src/env.ts:12`의 기본 TTL은 90초이므로 방송이 시작되지 않았는데 재시도가 “이미 방송 중”으로 거부될 수 있다. 기존 설계의 단일 writer와 중복 송출 방지는 유지해야 한다.

```ts
// apps/svc-core/src/channel/channel.service.ts:244-249
const acquired = await redis.set(liveKey(channelId), "1", "EX", env.LIVE_TTL_SECONDS, "NX");
if (acquired !== "OK") throw new ConnectError("channel already live", Code.AlreadyExists);
await db.insert(streams).values({ channelId, status: "live" });
return { channelId };
```

## 범위

- 수정 가능: `apps/svc-core/src/channel/channel.service.ts`, 새 `apps/svc-core/src/channel/channel.service.test.ts` 또는 기존 smoke의 단일 회귀 케이스.
- 제외: DB 스키마·마이그레이션, MediaMTX, 방송 키 인증 방식, Redis 장애 정책 전체.

## 단계와 검증

1. 이번 `startStream` 호출만 식별하는 임의 점유 값을 `SET NX`에 쓴다. DB insert 실패 때 Redis compare-and-delete(Lua 또는 동일한 원자 연산)로 자신의 값과 일치할 때만 키를 지운 뒤 원래 DB 오류를 다시 던진다. 단순 `DEL`은 TTL 만료 후 다른 방송이 획득한 키를 지울 수 있으므로 금지한다. `pnpm --filter @streamix/svc-core typecheck` → 종료 코드 0.
2. `apps/svc-core/src/auth/gate.test.ts`의 Vitest 스타일을 따라 DB insert 실패 후 즉시 재시도가 가능하고, 그 사이 다른 점유자가 생긴 경우에는 첫 호출의 정리가 새 점유를 지우지 않는 검사를 만든다. `pnpm --filter @streamix/svc-core test` → 모두 통과.
3. `pnpm --filter @streamix/svc-core lint`와 `pnpm --filter @streamix/svc-core typecheck` → 종료 코드 0. 기존 정상 시작·중복 시작·heartbeat·stop 경로가 유지되는지 로컬 스모크로 확인한다.

## 완료 기준

- DB insert 실패 뒤 남은 라이브 키가 없으며 즉시 재시작할 수 있다.
- 정리 중 TTL이 만료되어 재획득된 다른 점유는 삭제하지 않는다.
- 정상 방송과 중복 송출 차단이 유지되고 테스트·lint·타입 검사가 통과한다.

## 중단 조건·유지 메모

DB 실패가 이미 행을 커밋한 뒤의 응답 실패인지 구별할 수 없는 새 시나리오가 발견되면 Redis 삭제를 진행하지 말고 보고한다. 현재 `heartbeat`는 성공한 방송의 키를 갱신하므로, 점유 값 변경이 heartbeat의 동작과 충돌하지 않는지 리뷰한다. 커밋은 Conventional Commits를 따르고 별도 지시 없이 push/PR을 만들지 않는다.
