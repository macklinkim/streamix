# Build from the REPO ROOT: docker build -f apps/svc-media/Dockerfile -t streamix-svc-media .
# ffmpeg-static downloads a static linux ffmpeg during install (no apt ffmpeg needed).
# ADR-10: MediaMTX runs as a co-located sidecar in this image (ingest.ts publishes
# to rtmp://127.0.0.1, so it cannot live in a separate Fly app).
# Pinned by digest for reproducible builds (inbox/review.md V8-4); bump via a
# reviewed PR after checking the changelog.
FROM bluenviron/mediamtx:latest@sha256:371b6829a0e379ab0f2ed33fcb2f3a4145f854b79e9bf2a3671a5a4b813d580b AS mediamtx

FROM node:22-slim@sha256:a149cd71dccd68704a07d4e4ca3e610c27301852b0f556865cfdb6e2856f8bed AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/svc-media ./apps/svc-media
RUN pnpm install --frozen-lockfile --filter @streamix/svc-media...
RUN pnpm --filter @streamix/proto build \
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
