# 에러 계약 (Error Contract) — Phase 1 확정

BFF·서비스가 공유하는 단일 에러 규약. 런타임 상수는 `@streamix/schemas` (`errors.ts`)에서 import.

## 1. 도메인 에러 → Connect 코드 (unary/RPC)

브라우저↔BFF는 Connect 프로토콜. 서비스는 도메인 에러를 아래 Connect 코드로 매핑해 던지고,
`common.v1.ErrorDetail { code, message }`를 details로 첨부한다. `code`는 아래 `AppErrorCode` 문자열.

| AppErrorCode           | Connect Code         | HTTP(Connect) | 발생 예시                |
| ---------------------- | -------------------- | ------------- | ------------------------ |
| `invalid_credentials`  | `unauthenticated`    | 401           | 로그인 실패, access 만료 |
| `email_already_exists` | `already_exists`     | 409           | 회원가입 이메일 중복     |
| `slug_taken`           | `already_exists`     | 409           | 채널 slug 중복           |
| `not_found`            | `not_found`          | 404           | 채널/유저 없음           |
| `invalid_stream_key`   | `permission_denied`  | 403           | 스트림키 검증 실패       |
| `banned`               | `permission_denied`  | 403           | 밴 유저 액션             |
| `slowmode_active`      | `resource_exhausted` | 429           | 슬로우모드 중 전송       |
| `rate_limited`         | `resource_exhausted` | 429           | 레이트리밋 초과          |
| `validation`           | `invalid_argument`   | 400           | Zod 경계 검증 실패       |
| `internal`             | `internal`           | 500           | 예기치 못한 오류         |

가용성 폴백(§10): Redis 다운 시 `ListLive`는 Postgres 폴백(에러 아님), 채팅 서비스 불가 시 `unavailable`.

## 2. 채팅 WebSocket close-code 규약 (ADR-4)

브라우저↔BFF 채팅은 WS. 서버가 연결을 종료할 때 아래 close code를 사용. 앱 범위 4000–4999.

| WsCloseCode       | 값   | 의미                 | 클라이언트 처리         |
| ----------------- | ---- | -------------------- | ----------------------- |
| `NORMAL`          | 1000 | 정상 종료            | 재연결 안 함            |
| `SERVER_ERROR`    | 1011 | 서버 내부 오류       | 백오프 후 재연결        |
| `PROTOCOL_ERROR`  | 4000 | 잘못된 메시지 프레임 | 재연결 안 함(버그)      |
| `UNAUTHENTICATED` | 4001 | 토큰 없음/만료       | refresh 후 재연결       |
| `FORBIDDEN`       | 4003 | 밴/권한 없음         | 재연결 안 함, 안내 표시 |
| `ROOM_NOT_FOUND`  | 4004 | 채널 없음/종료       | 목록으로 이동           |
| `RATE_LIMITED`    | 4008 | 슬로우모드/과속      | 지연 후 재시도          |

> 전송(메시지 send)이 레이트리밋에 걸리면 연결을 끊지 않고 인밴드 에러 프레임으로 알리는 것을 기본으로 하되,
> 반복 위반 시 `RATE_LIMITED`(4008)로 종료한다. (구현: Phase 2 레이트리밋)
