FROM node:22-alpine

RUN apk update && apk upgrade --no-cache

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/cortex-memory-gateway.py scripts/hermes-mcp-launcher.mjs scripts/gateway-ab-test.py scripts/cleanup-duplicates.py ./scripts/

RUN npx tsc --noEmit

EXPOSE 3100

CMD ["npx", "tsx", "src/index.ts"]
