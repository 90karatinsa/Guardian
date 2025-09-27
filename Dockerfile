FROM node:20-bookworm-slim AS base

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
# Fail the build early when ffmpeg or onnxruntime native bindings are missing.
RUN command -v ffmpeg
RUN node -e "require('onnxruntime-node');"

FROM base AS runner

COPY package.json pnpm-lock.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY . .

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD pnpm exec tsx src/cli.ts daemon health || exit 1

CMD ["pnpm", "exec", "tsx", "src/cli.ts", "daemon", "start"]
