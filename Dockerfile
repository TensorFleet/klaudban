# syntax=docker/dockerfile:1.7

# ── build stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps with cache-friendly order (only re-runs npm ci when lockfile changes)
COPY package*.json ./
RUN npm ci

# Copy sources and build
COPY astro.config.mjs tailwind.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src
# The example config is bundled so missing-config doesn't break first-run; the
# actual user config gets mounted from outside at runtime (see docker-compose).
COPY tareas.config.example.json ./tareas.config.json
RUN npm run build

# ── runtime stage ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321

# Only ship what the SSR server actually needs at runtime
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# A baseline config gets baked in; the user mounts theirs at /app/tareas.config.json
# to override (see README + docker-compose).
COPY --from=builder /app/tareas.config.json ./tareas.config.json
# Empty vault skeleton so first boot doesn't crash with missing dirs. Users
# mount their real vault over /app/vault.
RUN mkdir -p vault/tareas/done vault/projects vault/embeds

EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
