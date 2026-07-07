FROM node:22-alpine

WORKDIR /app
COPY package.json package.json
RUN npm install --omit=dev
COPY server.js server.js

EXPOSE 8080
CMD ["node", "server.js"]
