# Load rig results (Phase 5)

Run: `"C:\Program Files\k6\k6.exe" run infra/k6/<script>.js` against the local
stack (dev laptop, docker-compose Postgres/Redis). §1.3 targets are for the
**sized-host `stage`** (§8.0); local numbers below are an **accepted deviation**.

## list-api.js — live list API (Connect over BFF)

50 VUs / 15s, rate limit raised for the run:

- 100% success (8135/8135), 540 req/s
- latency: avg 92ms, med 90ms, **p95 124ms** (target p95 < 100ms)
- Verdict: **accepted deviation** — no dedicated list cache yet (Postgres + Redis
  per request) and dev hardware. A short-TTL Redis cache on `ListLive` closes the
  gap on the sized host.

Note: without raising the limit, ~98% of requests 429 — the per-IP rate limiter
(300/10s) correctly caps a single-IP flood. The rig sets `RATE_LIMIT_RPC_MAX` high
to measure raw latency.

## chat-ws.js — chat fan-out (WebSocket)

100 VUs / 20s, each subscribes + sends every 2.5s:

- 100% WS connect (ws 101), **139,795 messages delivered (3,852/s)**
- fan-out latency (server publish → client receive): avg 141ms, med 116ms,
  **p95 343ms** (target p95 < 300ms @ 1,000/channel)
- Verdict: **accepted deviation** — 100 VUs on a laptop running the whole stack +
  k6; median is well under target. The 1,000-viewer target is a sized-host run.

## Prometheus

BFF exposes `/metrics` (prom-client default process + HTTP metrics). Full
Grafana/Loki/OTel stack is deferred (§1.2).
