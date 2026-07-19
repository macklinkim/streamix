# 작업계획서 — Drizzle unique-violation cause-chain 수정 + 회귀 테스트

상태: 제안(별도 작업). 범위 = svc-core 에러 매핑 1건 + 회귀 테스트 3종. 제품 배포 포함(core 재배포).

## 1. 배경 (확정된 회귀)

`6b9c003`(보안 8차, drizzle-orm 0.38.4→0.45.2) 이후 unique 위반 매핑이 전부 깨졌다.
drizzle 0.45가 드라이버 오류를 `DrizzleQueryError`로 감싸면서 Postgres 코드가
최상위 `.code`가 아니라 `.cause.code`("23505")로 내려간다.

`apps/svc-core/src/errors.ts:21` `isUniqueViolation`은 최상위 `.code`만 본다 → 항상 `false`.

실측(packages/db 직접 재현):

```
ctor: DrizzleQueryError · top-level .code: undefined
cause ctor: PostgresError · cause.code: "23505" · constraint: users_email_unique
```

영향(호출부 3곳, `isUniqueViolation` 사용처 전부):

| 위치                                                     | 기대                        | 현재(파손)                                                                                          |
| -------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `auth.service.ts:56` register 중복 이메일                | `EMAIL_ALREADY_EXISTS`(409) | `internal` → BFF 502                                                                                |
| `auth.service.ts:150` OAuth upsert(`provider_id` unique) | upsert 정상 분기            | `internal`                                                                                          |
| `channel.service.ts:126` CreateChannel 중복 slug         | `SLUG_TAKEN`                | 일반 실패 — 스튜디오가 "이미 사용 중인 slug입니다" 대신 "채널 생성에 실패했습니다"(**사용자 영향**) |

유입 커밋 메시지는 "smoke all green"이라 적었으나 두 스모크 모두 **중복 경로를 밟지 않는다**.
→ 수정과 함께 중복 경로를 밟는 회귀 테스트가 반드시 있어야 재발을 막는다.

## 2. 조치 (셋 다 포함 — 하나라도 빠지면 재발)

### 2.1 `isUniqueViolation` cause 체인 안전 순회 — `errors.ts`

- 최상위뿐 아니라 `e.cause`를 따라가며 `code === "23505"` 탐색.
- **무한 루프 방어**: 방문 집합(`Set`)으로 순환 참조 차단 + 최대 깊이(예: 8) 상한.
- 특정 제약 이름까지 좁힐 필요는 없다(호출부가 try 범위로 이미 어떤 unique인지 안다).

```ts
export function isUniqueViolation(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cur = e;
  for (let depth = 0; cur != null && depth < 8; depth++) {
    if (seen.has(cur)) break; // 순환 차단
    seen.add(cur);
    if (typeof cur === "object" && "code" in cur && (cur as { code?: unknown }).code === "23505") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
```

- 검증: 단위 테스트로 (a) 최상위 `.code` (b) `.cause.code`(1단계) (c) 순환 참조 (d) 무관 오류 4케이스.

### 2.2 이메일/slug 중복 회귀 테스트 — 실 DB 통합

drizzle/ORM/드라이버 업그레이드가 다시 오류 형태를 바꾸면 **여기서 깨지도록**. 단위 mock 아님 — 실 Postgres에 중복 insert를 유발해 매핑 코드를 검증.

- register 중복 이메일 → Connect `AlreadyExists`(BFF 경유 시 409).
- CreateChannel 중복 slug → `SLUG_TAKEN`. 가능하면 BFF/web 계층까지 포함해 스튜디오 문구("이미 사용 중인 slug입니다")가 뜨는지 확인(계약 회귀).
- 인프라: `apps/svc-core`에 vitest 도입(현재 없음, `scripts/smoke.ts`만 존재). CI `session-integration`과 동일하게 postgres service container 사용. 또는 기존 smoke 하니스에 중복 경로 case 추가(최소 변경 우선).

### 2.3 OAuth upsert 경로 회귀 테스트 — `auth.service.ts:150`

- `provider_id` unique 위반 경로. 현재 어떤 테스트도 이 분기를 밟지 않는다.
- 동일 `provider_id`로 두 번 upsert → 두 번째가 unique 위반을 잡아 기존 유저를 정상 반환(예외 누수 없음).

## 3. 실행 순서 · 검증 게이트

```
1. errors.ts cause-chain 수정        → verify: 단위 4케이스 green
2. svc-core vitest 도입(또는 smoke 확장) → verify: 프레임워크 실행
3. register/slug/OAuth 회귀 테스트 3종  → verify: 수정 전 red, 수정 후 green
4. 로컬 풀스택 실검증                  → verify: register 중복 409(502 아님),
                                        studio 중복 slug "이미 사용 중" 표시
5. core 재배포 + prod 실검증           → verify: prod register 중복 409
```

## 4. 주의

- 순수 매핑 수정이라 proto 무변경 → **core 단독 재배포**로 충분(bff/media 무관).
- 회귀 테스트는 반드시 **실 unique 위반**을 유발할 것. mock 오류 객체는 유입 커밋과 같은 착시를 만든다.
- 최소 변경 원칙: `errors.ts` 1함수 + 테스트만. 호출부 3곳은 `isUniqueViolation` 결과만 바뀌므로 무수정.
