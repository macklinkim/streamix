# Plan 002: 운영 의존성 감사 게이트 복구

> 시작 전 `git diff abea6eb..HEAD -- package.json apps/web/package.json apps/bff/package.json pnpm-lock.yaml .github/workflows/ci.yml`을 확인한다. 잠금 파일이나 매니페스트가 바뀌었다면 권고 버전을 다시 측정하고 계획 드리프트를 보고한다.

## 상태

- 우선순위: P1 · 노력: M · 수정 위험: 중간 · 의존: 없음
- 범주: migration/security · 계획 기준: `abea6eb`, 2026-09-27

## 이유와 현재 상태

CI의 `.github/workflows/ci.yml:54-55`는 `pnpm audit --prod --audit-level=high`를 하드 게이트로 실행한다. 현 잠금 파일에서 이 명령은 Critical 2건, High 15건으로 실패한다. `pnpm-lock.yaml:5977`의 Next 15.5.20, `:6746`의 sharp 0.34.5, `:4920`의 find-my-way 9.6.0, `:4851`의 fast-uri 3.1.3, `:5956`의 nanoid 3.3.15, `:6383`의 postcss 8.5.16이 보고됐다. CI 자체는 끄거나 완화하지 않는다.

2026-09-27 감사 응답의 최소 패치 범위: Next `>=15.5.24`, sharp `>=0.35.4`, find-my-way `>=9.7.0`, fast-uri `>=3.1.6`, nanoid `>=3.3.18`, postcss `>=8.5.18`. 이 버전은 실행 시 감사 결과로 재확인한다. `package.json:23-27`의 기존 postcss override는 8.5.16으로 고정되어 있어 특히 재검토가 필요하다. `apps/web/next.config.ts:24-26`에는 이미지 최적화 설정이 있어 Next/sharp 갱신 뒤 이미지 경로도 검증한다.

## 범위

- 수정 가능: `package.json`, `apps/web/package.json`, `apps/bff/package.json`, `pnpm-lock.yaml`; 꼭 필요한 동일 워크스페이스 매니페스트.
- 제외: `.github/workflows/ci.yml`의 감사 기준 완화, 임의의 프레임워크 메이저 업그레이드, 보안 권고와 무관한 일괄 업데이트.

## 단계와 검증

1. `pnpm audit --prod --json`으로 현재 advisory와 의존 경로를 재확인한다. 지금의 예상 결과는 Critical 2·High 15이다. 이미 해결됐다면 잠금 파일을 수정하지 않고 보고한다.
2. 직접 의존성을 패치된 호환 버전으로 갱신하고 잠금 파일을 재생성한다. 전이 의존성은 부모 패키지 갱신을 먼저 사용하고, 불가할 때만 범위가 좁은 `pnpm.overrides`를 쓴다. 기존 postcss override도 패치 버전 이상을 가리키도록 수정한다. `pnpm install --frozen-lockfile` → 종료 코드 0.
3. `pnpm audit --prod --audit-level=high` → 종료 코드 0. 나머지 Moderate 권고는 이 계획의 성공 기준에 포함하지 않는다.
4. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` → 모두 종료 코드 0. 웹 이미지 최적화 경로가 실제 사용되면 해당 로컬/스테이징 요청이 정상 반환되는지 확인한다.

## 완료 기준

- CI와 동일한 운영 의존성 감사 명령이 통과한다.
- 잠금 파일과 매니페스트가 일치한다. 타입 검사·lint·테스트·빌드가 통과한다.
- 감사 실패를 숨기기 위한 설정 변경이나 범위 밖 코드 수정이 없다.

## 중단 조건·유지 메모

패치 버전이 현재 Next 15 계열 또는 Fastify 5 계열과 호환되지 않아 메이저 업그레이드가 필요하면 중단하고 영향 범위를 보고한다. `pnpm audit` 권고는 시간에 따라 변하므로 실행일의 결과를 PR 검토에 첨부한다. 커밋은 Conventional Commits를 따르고 별도 지시 없이 push/PR을 만들지 않는다.
