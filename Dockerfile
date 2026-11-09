FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

RUN npx tsc --noEmit

# 4000, not 3100: the OmO 3D dashboard owns 3100 on the host by default
EXPOSE 4000

CMD ["npx", "tsx", "src/index.ts"]
