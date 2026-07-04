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
