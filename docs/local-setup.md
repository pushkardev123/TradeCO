# Local Setup

This setup runs local infrastructure only: Postgres and Redis. App services still run from the workspace with `npm` scripts so local secrets stay in `.env` files.

## 1. Install dependencies

```sh
npm install
```

## 2. Start local infrastructure

```sh
npm run dev:infra:up
```

This starts:

- Postgres on `localhost:5432`
- Redis on `localhost:6379`

The matching local database URL is:

```text
postgresql://tradeco:tradeco_local_password@localhost:5432/tradeco?schema=public
```

To stop infra without deleting data:

```sh
npm run dev:infra:down
```

To reset local infra data, run:

```sh
docker compose down -v
```

## 3. Create local env files

Copy each example and edit only local values:

```sh
cp apps/backend/.env.example apps/backend/.env
cp apps/event-service/.env.example apps/event-service/.env
cp apps/execution-service/.env.example apps/execution-service/.env
cp apps/frontend/.env.example apps/frontend/.env
```

Important:

- Do not commit `.env` files.
- Use the same `JWT_SECRET` in backend and event-service.
- Use the same 32-character `ENCRYPTION_KEY` in backend and execution-service.
- Do not put real Binance keys in service env files. Users provide Binance Spot Testnet keys during signup/onboarding.
- Keep `BINANCE_API_BASE` and `BINANCE_WS_BASE` on the Binance Spot Testnet hosts shown in the examples.
- Keep the backend and execution `ORDER_COMMAND_STREAM` defaults unless you intentionally need an isolated local stream. The backend still publishes `COMMANDS_CHANNEL` during the transition, but execution should keep `LEGACY_COMMANDS_CHANNEL_ENABLED=false` unless you are explicitly testing rollback.

## 4. Prepare Prisma

Run backend Prisma commands from the backend workspace:

```sh
npm --workspace apps/backend exec prisma validate
npm --workspace apps/backend exec prisma generate
npm --workspace apps/backend exec prisma migrate dev
```

The event service does not use database access in its current runtime, so it does not require a `DATABASE_URL` unless database code is introduced there later.

## 5. Run services

Use separate terminals:

```sh
npm run dev:backend
npm run dev:event
npm run dev:execution
npm run dev:frontend
```

Startup env validation fails fast with sanitized messages when required variables are missing or invalid.

## 6. Health checks

```sh
curl http://localhost:8080/health
curl http://localhost:8081/health
```

The health and startup output redact connection credentials and never print JWT secrets, encryption keys, Binance user API keys, refresh tokens, or signatures.

## 7. Redis Stream smoke check

With local Redis running, verify the order stream mechanics without Binance credentials:

```sh
npm run smoke:p2-redis-stream
```

This uses isolated smoke stream names, verifies a valid command is consumed and acknowledged, verifies an invalid command is acknowledged into the DLQ, and deletes the smoke streams before exiting.
