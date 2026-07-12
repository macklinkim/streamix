# Build from the REPO ROOT: docker build -f apps/svc-media/Dockerfile -t streamix-svc-media .
# ffmpeg-static downloads a static linux ffmpeg during install (no apt ffmpeg needed).
# ADR-10: MediaMTX runs as a co-located sidecar in this image (ingest.ts publishes
# to rtmp://127.0.0.1, so it cannot live in a separate Fly app).
# Pinned by digest for reproducible builds (inbox/review.md V8-4); bump via a
# reviewed PR after checking the changelog.
FROM bluenviron/mediamtx:latest@sha256:f37aaaf1a707c42b0aff49a3ab5d4fa57a3504ebc3f27657434a820e3b16d730 AS mediamtx

FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/svc-media ./apps/svc-media
RUN pnpm install --frozen-lockfile --filter @streamix/svc-media...
RUN pnpm --filter @streamix/proto --filter @streamix/schemas build \
  && pnpm --filter @streamix/svc-media build
RUN pnpm --filter @streamix/svc-media deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY infra/mediamtx.yml /etc/mediamtx.yml
# Sidecar auth callback stays on-machine (dev compose uses host.docker.internal).
ENV MTX_AUTHHTTPADDRESS=http://127.0.0.1:8091/mtx/auth
# RTMP ingest -> MediaMTX (1935) + HLS signed proxy (8090)
EXPOSE 1935 8090
CMD ["sh", "-c", "mediamtx /etc/mediamtx.yml & exec node dist/main.js"]
