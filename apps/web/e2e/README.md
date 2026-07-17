# Happy-path E2E

The single required automated E2E (§1.3, Phase 4 DoD): login → live list → watch → chat.
It runs against a live full stack; the browser drive lives in `happy-path.spec.ts`.

## Run

From the repo root, with `docker compose -f infra/docker-compose.yml up -d` running:

```bash
# 1. fresh db (deterministic fixture)
DATABASE_URL=postgres://streamix:streamix@localhost:5432/streamix \
  pnpm --filter @streamix/db db:drop-all && \
  DATABASE_URL=... pnpm --filter @streamix/db db:migrate

# 2. start services (each in its own shell / background)
node apps/svc-core/dist/main.js        # :50051
node apps/svc-chat/dist/main.js        # :50052
node apps/bff/dist/main.js             # :8080
node apps/svc-media/dist/main.js       # :1935 / :8090

# 3. seed the deterministic live fixture (keeps a stream running)
pnpm --filter @streamix/svc-media exec tsx scripts/e2e-seed.ts

# 4. start web + run the test
node apps/web/node_modules/next/dist/bin/next start -p 3000
pnpm --filter @streamix/web e2e
```

The player assertion checks the signed HLS playlist responds `200` (codec-agnostic,
so it passes on Chromium without proprietary H.264) rather than decoded frames.

# Broadcast E2E (camera / screen / RTMP)

`camera-broadcast.mts`, `screen-fallback.mts`, and `svc-media/scripts/smoke-rtmp-device.mts`
drive the studio and then prove a viewer at `/watch/<slug>` actually plays —
`<video>.currentTime` advancing, from its own browser process (a viewer tab in the
broadcaster's browser occludes it, and Chromium throttles the broadcaster's
MediaRecorder). Manifest/segment fetches are secondary assertions only.

## Required env — there are no defaults

Credentials differ per target, and a stale default silently 401s and reads like a
product failure. Every script fails with exit code 2 if any of these is missing:

| Var                  | Meaning                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `WEB`                | web origin under test (`http://localhost:3000`, `https://streamix-web.vercel.app`) |
| `EMAIL` / `PASSWORD` | broadcaster fixture account **on that target**                                     |
| `SLUG`               | that account's channel slug                                                        |
| `BFF_URL`            | API origin; defaults to prod — **always set it for local runs**                    |

Prepare a fixture on a target before the first run:

```bash
cd apps/svc-media
BFF_URL=http://localhost:8080 EMAIL=e2e@streamix.test PASSWORD=e2epassword123 \
  SLUG=e2e-live pnpm exec tsx ../web/e2e/seed-fixture.mts
```

## Run (from `apps/svc-media` — it has playwright + tsx)

```bash
# local full stack: docker compose up -d; db:migrate; pnpm dev
export WEB=http://localhost:3000 BFF_URL=http://localhost:8080
export EMAIL=e2e@streamix.test PASSWORD=e2epassword123 SLUG=e2e-live

pnpm exec tsx ../web/e2e/camera-broadcast.mts                  # desktop camera
SOURCE=screen pnpm exec tsx ../web/e2e/camera-broadcast.mts    # desktop screen
MOBILE=1 pnpm exec tsx ../web/e2e/camera-broadcast.mts         # phone, front/back preset
MOBILE=1 DEVICE_ID=1 pnpm exec tsx ../web/e2e/camera-broadcast.mts  # phone, detailed pick
pnpm exec tsx ../web/e2e/screen-fallback.mts                   # screen gating A/B/C + RTMP card
pnpm exec tsx scripts/smoke-rtmp-device.mts                    # RTMP device ingest
```

Exit codes: `0` all assertions passed · `1` an assertion failed · `2` misconfigured
(missing env, bad credentials).

## Side effects

`screen-fallback.mts` and `smoke-rtmp-device.mts` **rotate the fixture account's
durable stream key** (the plaintext key only exists in-session, so the card's
full-URL row needs a fresh one). Any OBS profile on the old key stops working.
`smoke-rtmp-device.mts` also takes the channel live for `SECONDS` (default 150).
Point these at a dedicated smoke account, never a real broadcaster's.
