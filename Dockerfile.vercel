# pnpm monorepo -> Next.js standalone server, packaged for Vercel Functions
# (Vercel auto-detects Dockerfile.vercel at the project root and routes all
# traffic to it; see https://vercel.com/docs/functions/container-images)
#
# Build context MUST be the repository root (Vercel Project Root Directory),
# because the pnpm lockfile / workspace file live there, not in apps/web.

FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install with the lockfile only, so this layer caches across
# source-only changes -------------------------------------------------------
FROM base AS deps
# native modules (better-sqlite3, sharp, msgpackr-extract, unrs-resolver) may
# need to compile from source if no prebuilt binary matches the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# ---- builder: bring in the rest of the source and build ------------------
FROM base AS builder
COPY --from=deps /app /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# DATABASE_URL / SESSION_SECRET are only read lazily at request time
# (see apps/web/src/config/server.ts), so the build does not need them.
# If a page ever starts reading env at build/SSG time, pass dummy values
# here via ARG/ENV so `next build` doesn't fail on a fresh Vercel builder.
RUN pnpm --filter @petrichor/web build

# ---- runner: minimal runtime image ----------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Vercel Functions route to port 80 by default; keep in sync with any
# PORT override you set in the Vercel project's Environment Variables.
ENV PORT=80
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

USER node
EXPOSE 80
CMD ["node", "apps/web/server.js"]
