# Plan 004: CSP 신고의 메트릭 라벨과 URI 로그를 제한

> 시작 전 `git diff abea6eb..HEAD -- apps/bff/src/routes/csp.ts apps/bff/src/routes`로 드리프트를 확인한다. 신고 형식이나 로깅 정책이 바뀌었다면 중단한다.

## 상태

- 우선순위: P1 · 노력: S · 수정 위험: 낮음 · 의존: 없음
- 범주: security/bug · 계획 기준: `abea6eb`, 2026-09-27

## 이유와 현재 상태

공개 `POST /csp-report`는 `apps/bff/src/routes/csp.ts:38-43`에서 요청 본문의 `effective-directive`를 그대로 Prometheus `directive` 라벨에 사용한다. `:45-58`의 분당 50건 제한은 로그에만 적용된다. 서로 다른 문자열을 보내면 BFF와 수집기에 시계열이 계속 늘 수 있다. 또 `blocked-uri`·`document-uri`가 쿼리·fragment·길이 제한 없이 로그에 남는다. 신고 입력은 인증되지 않았으므로 타입 단언만으로 문자열을 신뢰해서도 안 된다.

```ts
// apps/bff/src/routes/csp.ts:41-43,52-57
const directive =
  (r["effective-directive"] as string) || (r["violated-directive"] as string) || "unknown";
cspViolations.inc({ directive: directive.split(" ")[0] ?? "unknown" });
req.log.warn({
  cspViolation: { directive, blockedUri: r["blocked-uri"], documentUri: r["document-uri"] },
});
```

## 범위

- 수정 가능: `apps/bff/src/routes/csp.ts`, 새 `apps/bff/src/routes/csp.test.ts`.
- 제외: CSP 정책 헤더, `/metrics` 인증, 프런트엔드 신고 설정, 새 로깅/메트릭 의존성.

## 단계와 검증

1. `directive`를 실제 CSP 지시어의 유한한 허용 목록으로 매핑하고 나머지 값은 `other`로 합친다. 비문자열 입력도 안전하게 `other`가 되게 한다. 원문은 메트릭 라벨에 넣지 않는다. `pnpm --filter @streamix/bff typecheck` → 종료 코드 0.
2. 두 URI 로그 필드에는 URL의 query·fragment를 제거한 값만 쓰고 길이를 제한한다. 파싱 불가 또는 비문자열 값은 고정된 안전 값으로 기록한다. 원문 `directive`도 로그 길이 상한을 둔다. `pnpm --filter @streamix/bff typecheck` → 종료 코드 0.
3. `apps/bff/src/env.test.ts`의 Vitest 형식을 따라 Fastify `inject()`으로 신고를 보낸다. 서로 다른 임의 directive 여러 개가 같은 `other` 시계열에 집계되는지, 비문자열 필드가 500을 만들지 않는지, 로그에 query·fragment가 남지 않는지 확인한다. `pnpm --filter @streamix/bff test` → 모두 통과.

## 완료 기준

- 신고 개수와 무관하게 `directive` 라벨의 가능한 값 수가 고정된다.
- 로그에 신고 URI의 query·fragment 또는 무제한 문자열이 남지 않는다.
- 기존 204 응답·로그 샘플 제한은 유지되고 테스트·타입 검사가 통과한다.

## 중단 조건·유지 메모

실제 브라우저의 필수 directive가 허용 목록에서 누락되어 운영 분석이 불가능해지면 목록을 근거와 함께 조정한다. `other` 증가율을 모니터링하되 요청값을 다시 라벨로 넣지 않는다. 커밋은 Conventional Commits를 따르고 별도 지시 없이 push/PR을 만들지 않는다.
