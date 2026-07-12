# Build from the REPO ROOT: docker build -f apps/svc-core/Dockerfile -t streamix-svc-core .
# node:22-slim (glibc) so argon2 uses its prebuilt binary. Generated proto is
# committed, so no buf step is needed in the image.
FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/svc-core ./apps/svc-core
RUN pnpm install --frozen-lockfile --filter @streamix/svc-core...
RUN pnpm --filter @streamix/proto --filter @streamix/db --filter @streamix/schemas build \
  && pnpm --filter @streamix/svc-core build
RUN pnpm --filter @streamix/svc-core deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=50051
WORKDIR /app
COPY --from=build /out ./
EXPOSE 50051
CMD ["node", "dist/main.js"]
