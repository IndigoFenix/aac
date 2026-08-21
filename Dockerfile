# =============================================================================
# Aivota API image — ECS Fargate (long-lived container)
# =============================================================================
# Server only. The clinician SPA, the AAC web build and the landing pages are
# built by the deploy workflow and published to S3 + CloudFront; this image
# never serves them (app.prod.ts runs API-only when dist/public is absent).
# Mirrors Dockerfile.lambda minus the Web Adapter.

FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies (native modules)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

# Server sources + what the bundle reaches at build time
COPY server/ ./server/
COPY shared/ ./shared/
COPY drizzle/ ./drizzle/
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY rds-ca-bundle.pem ./

# esbuild bundles server/index.prod.ts (+ the dynamically imported app.prod.ts)
# into dist/index.prod.js. Same flags as `npm run build`, minus the clients.
RUN npx esbuild server/index.prod.ts --platform=node --packages=external --bundle --format=esm --outdir=dist

# =============================================================================
# Production stage
# =============================================================================
FROM node:20-alpine AS production

WORKDIR /app

# wget is used by the ECS container health check
RUN apk add --no-cache wget

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Game bundles (~94 MB), built by the CI runner — NOT in the builder stage
# above, which would put the whole game toolchain and a 16-game vite build into
# every image build, including deploys that never touch a game.
#
# Deliberately copied BEFORE the server bundle: a COPY invalidates every layer
# below it, and the server bundle changes on every single deploy. Ordered the
# other way round, a routine server-only deploy would re-push ~94 MB it did not
# change. Here that layer stays cached until the games themselves change.
#
# The bracketed source is Docker's optional-COPY idiom: `public-game[s]` is a
# glob, and a glob matching nothing is not an error, so an image built without
# running `npm run build:games` still succeeds. `app.prod.ts` already guards on
# the directory existing and simply leaves /games unmounted — which is exactly
# today's behavior. Requires a `!dist/public-games` exception in .dockerignore,
# since `dist` is otherwise excluded wholesale.
COPY dist/public-game[s] ./dist/public-games

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/rds-ca-bundle.pem ./rds-ca-bundle.pem
COPY --from=builder /app/rds-ca-bundle.pem ./dist/rds-ca-bundle.pem

# Non-root runtime user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/health || exit 1

CMD ["node", "dist/index.prod.js"]
