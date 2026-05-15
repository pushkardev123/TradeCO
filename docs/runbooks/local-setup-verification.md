# Local Setup Verification

Status: Initial structure; accurate for current local service commands.

Tracker row: https://www.notion.so/3608ea2b3f8a81ff8e58dbde4c5b164a

## Owner

Primary owner: Developer running the local environment.

Backup owner: Service owner for the failing service.

## Scope

Use this runbook to install dependencies, provide local environment variables, start services, and verify local health without adding real credentials to the repository.

## Required Configuration

Backend requires:

- `DATABASE_URL`
- `JWT_SECRET`
- `ENCRYPTION_KEY` with exactly 32 characters
- `REDIS_URL`

Event service requires:

- `REDIS_URL`
- `JWT_SECRET` for authenticated scoped updates
- `DATABASE_URL` only if database access is introduced for the task

Execution service requires:

- `REDIS_URL`
- `DATABASE_URL`
- `ENCRYPTION_KEY` with exactly 32 characters
- Optional Binance Spot Testnet base URLs when defaults should not be used

Frontend uses public configuration such as:

- `NEXT_PUBLIC_BACKEND_URL`
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_EVENT_SERVICE_URL`
- `NEXT_PUBLIC_WS_URL`

## Safety Rules

- Do not commit `.env` files.
- Do not invent secret defaults in code.
- Do not paste real keys into README, runbooks, Notion, or terminal transcripts.
- Use testnet-only Binance keys.
- Do not run live Binance verification unless the task explicitly requires it and credentials are available.

## Setup Procedure

1. Install dependencies:

   ```sh
   npm install
   ```

2. Provide service environment variables through local `.env` files or shell environment outside git.

3. Start the services that are relevant to the task:

   ```sh
   npm run dev:frontend
   npm run dev:backend
   npm run dev:event
   npm run dev:execution
   ```

4. Verify health for services that expose health endpoints:

   - Backend: `GET /health`
   - Event service: `GET /health`

5. For frontend changes, run the relevant checks when practical:

   ```sh
   npm --workspace apps/frontend run lint
   npm --workspace apps/frontend run build
   ```

6. For Prisma schema changes, validate and generate from the service that owns the schema:

   ```sh
   npx prisma validate
   npx prisma generate
   ```

## Verification Checks

- Dependency installation completes.
- Required environment variables are present for the service under test.
- Backend and event service health endpoints return ok when those services are started.
- No command output contains real credentials, JWTs, signatures, refresh tokens, or encrypted credential payloads.
- Any blocked check records the exact missing dependency, such as Redis, Postgres, Binance credentials, or environment variables.

## Risks

- Event service currently defaults `REDIS_URL` to local Redis if unset; production-like environments should set it explicitly.
- Backend and execution service fail fast when required secrets are missing.
- Frontend currently stores access tokens in `localStorage`; do not use shared browsers for sensitive test accounts.

## Pending Implementation-Dependent Work

- Add sanitized `.env.example` files after service owners agree on the expected variables and non-secret example values.
- Add service-specific smoke test commands when they exist.
- Add local Redis/Postgres bootstrap instructions if the repo adds Docker Compose or equivalent tooling.
