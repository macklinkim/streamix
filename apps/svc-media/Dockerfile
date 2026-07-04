# Build from the REPO ROOT: docker build -f apps/svc-media/Dockerfile -t streamix-svc-media .
# ffmpeg-static downloads a static linux ffmpeg during install (no apt ffmpeg needed).
FROM node:22-slim AS base
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
# RTMP ingest (1935) + HLS authz HTTP (8090)
EXPOSE 1935 8090
CMD ["node", "dist/main.js"]
