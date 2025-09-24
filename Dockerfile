FROM node:20-bookworm-slim AS base

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD pnpm exec tsx src/cli.ts --health || exit 1

CMD ["pnpm", "start"]
