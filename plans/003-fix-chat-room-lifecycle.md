# Plan 003: 채팅 소켓 종료와 룸 재가입 경합 해결

> 시작 전 `git diff abea6eb..HEAD -- apps/bff/src/ws/chat.ts apps/bff/src/ws`로 드리프트를 확인한다. 인용한 함수의 구조가 달라졌으면 중단한다.

## 상태

- 우선순위: P1 · 노력: M · 수정 위험: 중간 · 의존: 없음
- 범주: bug · 계획 기준: `abea6eb`, 2026-09-27

## 이유와 현재 상태

`apps/bff/src/ws/chat.ts:297,304,309`는 `coreAuth.me`와 `joinRoom`을 기다린 뒤에야 룸 퇴장용 `close` 핸들러를 붙인다. 그 사이 소켓이 닫히면 이벤트를 놓친 채 `joinRoom:188-189`가 소켓과 viewer 카운트를 남긴다. 별도로 `leaveRoom:197-201`은 마지막 소켓 퇴장 시 `unsubscribe()`를 기다리는 동안 룸을 Map에 남긴다. `joinRoom:166-189`가 이 룸에 새 소켓을 붙이면, 오래된 퇴장 작업이 살아 있는 룸을 삭제하고 채팅 구독을 끊는다. 현재 룸은 Redis 구독 한 개를 여러 소켓이 공유하는 구조(ADR-4)이며 50ms 배칭·슬로우 소비자 보호는 유지해야 한다.

```ts
// apps/bff/src/ws/chat.ts:188-201
room.sockets.add(socket);
await redis.incr(viewersKey(channelId)).catch(() => {});
// ...
room.sockets.delete(socket);
await redis.decr(viewersKey(channelId)).catch(() => {});
if (room.sockets.size === 0) {
  await room.sub.unsubscribe().catch(() => {});
  room.sub.disconnect();
  rooms.delete(channelId);
}
```

## 범위

- 수정 가능: `apps/bff/src/ws/chat.ts`, 새 `apps/bff/src/ws/chat.test.ts` 또는 동등한 단일 회귀 테스트.
- 제외: 채팅 프로토콜·메시지 내용, `svc-chat`, 새 외부 의존성, 팬아웃 배칭 정책.

## 단계와 검증

1. 소켓 `close`를 비동기 사용자 조회·룸 가입 전에 추적한다. `await` 이후에는 `readyState`를 확인하고, 이미 종료된 소켓은 가입시키지 않는다. 가입 도중 종료되면 정확히 한 번 퇴장시킨다. viewer 증감은 `room.sockets.add/delete`의 실제 성공 여부와 맞춘다. `pnpm --filter @streamix/bff typecheck` → 종료 코드 0.
2. 마지막 소켓 퇴장 시 해제 중인 룸을 신규 가입이 재사용하지 못하게 한다. Map에서 먼저 분리하고 해제하는 방식이라면 오래된 작업이 새 룸을 삭제하지 않도록 객체 동일성을 검사한다. 룸 생성 중 `subscribe()`가 실패할 때 동시 가입자가 `ready`를 받지 않는지도 확인한다. `pnpm --filter @streamix/bff typecheck` → 종료 코드 0.
3. `apps/bff/src/env.test.ts`의 Vitest 형식을 참고해 지연된 `coreAuth.me`, 지연된 Redis `subscribe/unsubscribe`, 조기 `close`를 제어하는 테스트를 만든다. 경우: 조회 중 종료 → 룸/viewer 0; 가입 중 종료 → 0; 마지막 퇴장 중 새 가입 → 새 소켓 수신 가능; 구독 실패 중 동시 가입 → 성공 `ready` 없음. `pnpm --filter @streamix/bff test` → 모두 통과.

## 완료 기준

- 닫힌 소켓이 룸에 남지 않고 viewer 카운트가 음수/누수되지 않는다.
- 해제와 재가입이 겹쳐도 새 소켓은 활성 구독을 가진다.
- 기존 BFF 테스트·타입 검사 통과, 수정 범위 준수.

## 중단 조건·유지 메모

테스트를 위해 채팅 프로토콜이나 Redis 소유 구조 전체를 바꿔야 한다면 중단한다. 운영 검증에서는 `/metrics`의 WS 연결·룸 게이지가 연결 종료 후 기준치로 돌아오는지 확인한다. 이 계획은 조기 종료와 재가입 두 경합을 함께 고친다. 한쪽만 수정한 상태로 DONE 처리하지 않는다. 커밋은 Conventional Commits를 따르고 별도 지시 없이 push/PR을 만들지 않는다.
