# Build from the REPO ROOT as context (monorepo):
#   docker build -f apps/bff/Dockerfile -t streamix-bff .
#   fly deploy --config apps/bff/fly.toml --dockerfile apps/bff/Dockerfile   (run from root)
FROM node:22-slim@sha256:a149cd71dccd68704a07d4e4ca3e610c27301852b0f556865cfdb6e2856f8bed AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/bff ./apps/bff
RUN pnpm install --frozen-lockfile --filter @streamix/bff...
RUN pnpm --filter @streamix/proto --filter @streamix/schemas build \
  && pnpm --filter @streamix/bff build
RUN pnpm --filter @streamix/bff deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build /out ./
EXPOSE 8080
CMD ["node", "dist/main.js"]
