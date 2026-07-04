# BFF ↔ 서비스 통신 규약 — Phase 1

## 평면 분리 (§2)

- **제어 평면**: 브라우저 → BFF → 내부 gRPC(svc-core/svc-chat). BFF가 유일한 제어 진입점.
- **데이터 평면**: OBS(RTMP) → svc-media → R2/CDN → hls.js. **BFF 우회**, 재생 인가는 서명 URL.

## 브라우저 ↔ BFF

| 용도                  | 프로토콜    | 경로                | 비고                      |
| --------------------- | ----------- | ------------------- | ------------------------- |
| RPC(unary/서버스트림) | Connect-Web | `/connect/*`        | ADR-1. 클라 스트리밍 불가 |
| 채팅                  | WebSocket   | `/ws`               | ADR-4. 양방향             |
| HLS 재생              | HTTP GET    | `/hls/*` (CDN 직접) | BFF 우회, 서명 URL        |

## BFF ↔ 내부 서비스 (gRPC over HTTP/2)

| 대상     | 서비스                      | 예시 RPC                                                           |
| -------- | --------------------------- | ------------------------------------------------------------------ |
| svc-core | `user.v1.AuthService`       | Register/Login/Refresh/Me                                          |
| svc-core | `channel.v1.ChannelService` | CreateChannel/GetChannel/ListLive/ValidateStreamKey/GetPlaybackUrl |
| svc-chat | `chat.v1.ChatService`       | Join(서버스트림)/Send/Moderate                                     |

- 주소: dev는 `localhost:<port>`, prod(Fly)은 사설 네트워킹 `<app>.internal:<port>`.
- 인증: BFF가 access JWT 검증 후 내부 호출에 유저 컨텍스트(메타데이터) 전파. 내부는 내부망 신뢰 + 서비스 토큰(mTLS는 🧪).
- 에러: 서비스는 `docs/error-contract.md`의 AppErrorCode→Connect 코드로 매핑, BFF는 그대로 클라에 전달.

## svc-media ↔ svc-core

- `ValidateStreamKey`(송출 시작 시), `StartStream`/`StopStream`/`Heartbeat`(라이브 상태 통지).
- **라이브 상태 쓰기는 Core만**(단일 writer, §5.2): SET NX·TTL·heartbeat·첫 세그먼트 후 노출.

## 포트 (dev)

| 서비스                  | 포트        |
| ----------------------- | ----------- |
| bff (HTTP/Connect/WS)   | 8080        |
| svc-core (gRPC)         | 50051       |
| svc-chat (gRPC)         | 50052       |
| svc-media (RTMP / HTTP) | 1935 / 8090 |
| web (Next.js)           | 3000        |
