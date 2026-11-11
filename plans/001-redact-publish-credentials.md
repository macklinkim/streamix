# Plan 001: 방송 자격증명을 Media 로그에서 제거

> 실행자는 아래 범위만 수정한다. 시작 전 `git diff abea6eb..HEAD -- apps/svc-media/src/main.ts apps/svc-media/src/ingest.ts`로 드리프트를 확인한다. 인용 코드가 달라졌다면 중단하고 보고한다.

## 상태

- 우선순위: P1 · 노력: S · 수정 위험: 낮음 · 의존: 없음
- 범주: security · 계획 기준: `abea6eb`, 2026-09-27

## 이유와 현재 상태

MediaMTX publish 경로의 마지막 세그먼트는 `apps/svc-media/src/main.ts:29`에서 `keyOf(mtxPath)`로 추출되어 Core의 스트림 키 검증에 쓰인다. 즉 경로에는 OBS 영구 키 또는 브라우저 인제스트 토큰이 들어간다. `main.ts:123,126,143`은 그 경로 전체를 `console.log/warn`으로 기록한다. `ingest.ts:207-217`은 ffmpeg 목적지에 같은 토큰을 넣고 stderr를 상속하므로 ffmpeg 진단 출력에도 목적지가 노출될 수 있다. 정상 방송의 시작·종료만으로도 자격증명이 로그에 축적된다.

현재 코드의 핵심 형태:

```text
// apps/svc-media/src/main.ts:123,126,143
console.log(`live ${mtxPath} -> channel ${channelId}`);
console.warn(`startStream rejected ${mtxPath}: ${code} — kicking publisher`);
console.log(`offline ${mtxPath} -> channel ${s.channelId}`);
// apps/svc-media/src/ingest.ts:217
{ stdio: ["pipe", "ignore", "inherit"] }
```

모노레포의 TypeScript 스타일을 따르고, 새 로깅 프레임워크는 도입하지 않는다. 방송 키·토큰의 실제 값은 테스트 출력이나 문서에 쓰지 않는다.

## 범위

- 수정 가능: `apps/svc-media/src/main.ts`, `apps/svc-media/src/ingest.ts`; 필요하면 관련 테스트 파일 1개.
- 제외: 스트림 키 형식·인증 계약, MediaMTX 경로, Core API, 운영 로그 저장소의 직접 수정.

## 단계와 검증

1. `main.ts`의 세 로그에서 `mtxPath`를 없앤다. 정상 시작·종료는 이미 가진 `channelId`만 기록하고, 거절은 안전한 오류 코드만 기록한다. `rg -n 'console\.(log|warn).*mtxPath' apps/svc-media/src/main.ts` → 결과 없음.
2. `ingest.ts`에서 ffmpeg의 목적지 포함 stderr가 서비스 로그로 그대로 전달되지 않게 한다. 우선 ffmpeg의 출력 제어 옵션과 `stdio`만 조정하고, 종료 코드·송출 실패 감지는 유지한다. `rg -n '"inherit"|stdio' apps/svc-media/src/ingest.ts` → 자격증명 포함 stderr 상속 없음.
3. `pnpm --filter @streamix/svc-media typecheck`와 `pnpm --filter @streamix/svc-media test` → 모두 종료 코드 0. 로컬 송출 스모크에서 임의 테스트 키로 시작·종료·거절을 실행하고 수집 로그에 테스트 키가 없는지 확인한다. 실제 운영 키는 출력하지 않는다.

## 완료 기준

- 세 이벤트 로그와 ffmpeg 진단 출력에 publish 경로 또는 인제스트 토큰이 남지 않는다.
- 정상/거절/종료 결과와 방송 상태는 기존처럼 유지된다.
- 위 타입 검사·테스트가 통과하고 범위 밖 파일이 바뀌지 않는다.

## 중단 조건·유지 메모

ffmpeg 진단 출력을 줄였을 때 실패 원인을 식별할 방법이 전혀 없어지면 중단하고 안전한 오류 요약 방식을 제안한다. 배포 후 과거 로그의 보존 범위를 조사하고, 노출된 영구 스트림 키가 확인되면 운영자가 해당 키를 회전해야 한다. 로그 데이터 삭제는 이 코드 계획 범위 밖이다. 커밋은 리포의 Conventional Commits 형식을 따른다. 별도 지시 없이 push/PR을 만들지 않는다.
