# TradeCO Deployment

TradeCO is a Binance Spot Testnet app. Keep production Binance endpoints out of deployment config unless a future tracker item explicitly changes that scope.

## One-command Docker Compose stack

Copy the deploy env template and fill secrets:

```sh
cp .env.deploy.example .env.deploy
```

Required changes before first run:

- `TRADECO_POSTGRES_PASSWORD`: use a strong value.
- `TRADECO_POSTGRES_USER`: keep this short; PostgreSQL role names must be at most 63 bytes.
- `JWT_SECRET`: at least 32 characters, shared by backend and event service.
- `ENCRYPTION_KEY`: exactly 32 characters, shared by backend and execution service.
- For a domain behind nginx, update `PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_EVENT_SERVICE_URL`, and `NEXT_PUBLIC_WS_URL`.

## Production environment values

For a single-domain nginx deployment, fill these values in `.env.deploy` before building the frontend image:

```sh
TRADECO_POSTGRES_DB=tradeco
TRADECO_POSTGRES_USER=tradeco
TRADECO_POSTGRES_PASSWORD=<strong-database-password>
JWT_SECRET=<random-32-plus-character-secret>
ENCRYPTION_KEY=<exactly-32-characters>
PUBLIC_APP_ORIGIN=https://tradeco.example.com
NEXT_PUBLIC_BACKEND_URL=https://tradeco.example.com/api
NEXT_PUBLIC_API_URL=https://tradeco.example.com/api
NEXT_PUBLIC_EVENT_SERVICE_URL=https://tradeco.example.com/event
NEXT_PUBLIC_WS_URL=wss://tradeco.example.com/ws/prices
NEXT_PUBLIC_ENABLE_ADVANCED_ORDERS=true
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
BINANCE_API_BASE=https://testnet.binance.vision
BINANCE_WS_BASE=wss://stream.testnet.binance.vision
BINANCE_WS_API_BASE=wss://ws-api.testnet.binance.vision/ws-api/v3
```

For PM2 or any non-Compose deployment, also provide direct runtime URLs:

```sh
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<db>?schema=public
REDIS_URL=redis://<host>:6379
```

Set `DATABASE_URL` directly if your database password contains URL-reserved characters; URL-encode the password value before putting it in the connection string.

When using the bundled Compose Postgres service, prefer leaving `DATABASE_URL` unset so Compose derives it from `TRADECO_POSTGRES_USER`, `TRADECO_POSTGRES_PASSWORD`, and `TRADECO_POSTGRES_DB`. If you do set `DATABASE_URL` with host `postgres`, keep those values exactly in sync.

Keep all Binance user API keys out of `.env.deploy`; users provide their own Testnet keys during signup/onboarding.

Start everything:

```sh
npm run deploy:compose:up
```

This starts Postgres, Redis, a one-shot Prisma migration container, backend, event service, execution service, and frontend.

Check logs:

```sh
npm run deploy:compose:logs
```

Stop the stack:

```sh
npm run deploy:compose:down
```

Validate the rendered compose file:

```sh
npm run deploy:compose:config
```

Run the deploy env preflight without rendering Compose:

```sh
npm run deploy:compose:check-env
```

## Local direct-port URLs

The default `.env.deploy.example` exposes:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:8080`
- Event service HTTP/WebSocket: `http://localhost:8081` and `ws://localhost:8081/prices`

## Redis and Postgres choice

The Docker Compose stack runs local Postgres and Redis containers by default. Redis is exposed on `127.0.0.1:6379` for local smoke tests, while services use the internal Compose URL `redis://redis:6379`.

For production you can keep these containers with named Docker volumes, or replace them with managed services. If you use managed services, set `DATABASE_URL` and `REDIS_URL` directly in the runtime environment or adapt `docker-compose.deploy.yml` to stop launching the bundled `postgres` and `redis` services.

## Nginx reverse proxy

Use [deploy/nginx/tradeco.conf](../deploy/nginx/tradeco.conf) as the starting point.

For a domain such as `https://tradeco.example.com`, set these deploy env values before building the frontend image:

```sh
PUBLIC_APP_ORIGIN=https://tradeco.example.com
NEXT_PUBLIC_BACKEND_URL=https://tradeco.example.com/api
NEXT_PUBLIC_API_URL=https://tradeco.example.com/api
NEXT_PUBLIC_EVENT_SERVICE_URL=https://tradeco.example.com/event
NEXT_PUBLIC_WS_URL=wss://tradeco.example.com/ws/prices
NEXT_PUBLIC_ENABLE_ADVANCED_ORDERS=true
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
```

Then rebuild:

```sh
npm run deploy:compose:up
```

The sample nginx config maps:

- `/` to frontend port `3000`
- `/api/` to backend port `8080`
- `/event/` to event-service HTTP port `8081`
- `/ws/` to event-service WebSocket port `8081`

Operational health endpoints:

- Backend: `GET /health` on port `8080`
- Event service: `GET /health` on port `8081`
- Execution service: `GET /health` on `HEALTH_PORT`, exposed by Compose as `EXECUTION_HEALTH_PORT` and defaulting to `8082`

Backend, event-service, and execution-service logs are structured JSON lines. Use `X-Request-Id` or `X-Trace-Id` on API calls when you want a known correlation id to follow an order from backend request through Redis Stream processing and execution logs.

## PM2 alternative

Use PM2 only for a non-Docker Node deployment. Docker Compose already restarts containers with `restart: unless-stopped`, so running PM2 inside the app containers is unnecessary.

For a bare-metal PM2 deployment:

```sh
npm install
npx prisma generate --schema apps/backend/prisma/schema.prisma
npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
npm --workspace apps/frontend run build
set -a
source .env.deploy
set +a
pm2 start ecosystem.config.cjs
```

All backend, event-service, and execution-service environment variables must be present in the shell or PM2 environment before starting.

## Safety checklist

- `.env.deploy` is not committed.
- `BINANCE_API_BASE` remains `https://testnet.binance.vision`.
- `BINANCE_WS_BASE` remains `wss://stream.testnet.binance.vision`.
- `BINANCE_WS_API_BASE` remains `wss://ws-api.testnet.binance.vision/ws-api/v3`.
- User Binance Testnet API keys are entered during signup/onboarding only.
- Do not put API keys, JWTs, refresh tokens, signatures, or encrypted credential payloads in logs or deployment docs.
- Treat structured logs as operational telemetry: they should contain request ids, trace ids, order ids, stream ids, status, and safe error codes/messages only.
