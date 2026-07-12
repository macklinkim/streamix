# Build from the REPO ROOT: docker build -f apps/svc-chat/Dockerfile -t streamix-svc-chat .
FROM node:22-slim@sha256:a149cd71dccd68704a07d4e4ca3e610c27301852b0f556865cfdb6e2856f8bed AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/svc-chat ./apps/svc-chat
RUN pnpm install --frozen-lockfile --filter @streamix/svc-chat...
RUN pnpm --filter @streamix/proto --filter @streamix/schemas build \
  && pnpm --filter @streamix/svc-chat build
RUN pnpm --filter @streamix/svc-chat deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=50052
WORKDIR /app
COPY --from=build /out ./
EXPOSE 50052
CMD ["node", "dist/main.js"]
