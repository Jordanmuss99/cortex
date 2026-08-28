FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /app
COPY oauth-gateway/package.json oauth-gateway/package-lock.json ./
RUN npm ci --omit=dev
COPY oauth-gateway/server.js server.js
COPY oauth-gateway/admin.js admin.js
COPY oauth-gateway/chatgpt-tools.js chatgpt-tools.js
COPY oauth-gateway/app.js app.js
COPY oauth-gateway/agent-policy.js agent-policy.js
COPY oauth-gateway/config.js config.js
COPY oauth-gateway/legacy-state.js legacy-state.js
COPY oauth-gateway/oauth-crypto.js oauth-crypto.js
COPY oauth-gateway/oauth-store.js oauth-store.js
COPY oauth-gateway/security-log.js security-log.js
COPY oauth-gateway/server-v2.js server-v2.js
# Keep the same relative source layout used by server-v2.js so its default
# migration checksum path works in the packaged runtime without a bind mount.
COPY db/migrations/009_oauth_authority.sql /db/migrations/009_oauth_authority.sql
COPY db/migrations/010_memory_lifecycle.sql /db/migrations/010_memory_lifecycle.sql

EXPOSE 8080
CMD ["node", "server.js"]
