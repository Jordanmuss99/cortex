FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/cortex-memory-gateway.py scripts/hermes-mcp-launcher.mjs scripts/gateway-ab-test.py scripts/cleanup-duplicates.py scripts/reflect-cursor.ts scripts/reflect-multi.ts scripts/run-metacognition.ts scripts/run-self-check.ts scripts/run-migrations.ts scripts/prepare-oauth-database.ts scripts/retry-memory-ingest.ts ./scripts/

RUN npx tsc
RUN find dist -type d -name __tests__ -prune -exec rm -rf '{}' +
RUN find dist/scripts -maxdepth 1 -type f -name 'reflect-multi.*' -delete

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

RUN apk update && apk upgrade --no-cache
RUN npm install --global supergateway@3.4.3

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY db/migrations ./dist/db/migrations

EXPOSE 3100

CMD ["node", "dist/src/index.js"]
