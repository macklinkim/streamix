# Build from the REPO ROOT: docker build -f apps/web/Dockerfile -t streamix-web .
# NEXT_PUBLIC_* are inlined at build time, so they must be build args.
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_BFF_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_RTMP_URL
ENV NEXT_PUBLIC_BFF_URL=$NEXT_PUBLIC_BFF_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_RTMP_URL=$NEXT_PUBLIC_RTMP_URL
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @streamix/web...
RUN pnpm --filter @streamix/proto build \
  && pnpm --filter @streamix/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=build /app ./
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
