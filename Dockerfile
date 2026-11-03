# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 ships prebuilt binaries; the toolchain is the fallback when none match.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/chat.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
