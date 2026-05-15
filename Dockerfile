# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache openssl

FROM base AS deps
ARG TARGETARCH
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/event-service/package.json apps/event-service/package.json
COPY apps/execution-service/package.json apps/execution-service/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/redis-stream-contracts/package.json packages/redis-stream-contracts/package.json
RUN npm ci
RUN case "$TARGETARCH" in \
      amd64) npm install --no-save lightningcss-linux-x64-musl@1.30.2 @tailwindcss/oxide-linux-x64-musl@4.1.18 ;; \
      arm64) npm install --no-save lightningcss-linux-arm64-musl@1.30.2 @tailwindcss/oxide-linux-arm64-musl@4.1.18 ;; \
      *) echo "Unsupported Docker TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_BACKEND_URL=http://localhost:8080
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ARG NEXT_PUBLIC_EVENT_SERVICE_URL=http://localhost:8081
ARG NEXT_PUBLIC_WS_URL=ws://localhost:8081/prices
ARG NEXT_PUBLIC_MARKET_FLUSH_MS=1500
ARG NEXT_PUBLIC_MAX_SYMBOLS=1000
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_EVENT_SERVICE_URL=$NEXT_PUBLIC_EVENT_SERVICE_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_MARKET_FLUSH_MS=$NEXT_PUBLIC_MARKET_FLUSH_MS
ENV NEXT_PUBLIC_MAX_SYMBOLS=$NEXT_PUBLIC_MAX_SYMBOLS
RUN npx prisma generate --schema apps/backend/prisma/schema.prisma
RUN npm --workspace apps/frontend run build

FROM build AS backend
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/backend/src/index.js"]

FROM build AS event-service
ENV NODE_ENV=production
ENV PORT=8081
EXPOSE 8081
CMD ["node", "apps/event-service/src/index.js"]

FROM build AS execution-service
ENV NODE_ENV=production
CMD ["node", "apps/execution-service/src/index.js"]

FROM build AS frontend
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["npm", "--workspace", "apps/frontend", "run", "start"]
