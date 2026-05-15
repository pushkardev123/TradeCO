# Service Recovery

Status: Initial structure. Local recovery steps are accurate; deployment-specific commands are pending.

Tracker row: https://www.notion.so/3608ea2b3f8a81ff8e58dbde4c5b164a

## Owner

Primary owner: Service owner for the failing service.

Backup owner: Backend/API owner for auth, credential, database, and order gateway incidents; execution service owner for Binance/testnet incidents.

## Scope

Use this runbook when a TradeCO service is down, degraded, or returning incorrect errors in a testnet environment.

## Triage Procedure

1. Identify the failing service.
   Check frontend behavior, backend `/health`, event service `/health`, service logs, and whether Redis/Postgres are reachable.

2. Classify the failure.
   Use these categories: missing environment variable, Redis unavailable, Postgres unavailable, JWT/auth failure, credential decrypt failure, Binance Spot Testnet failure, deployment/runtime failure, or unknown.

3. Preserve secret hygiene.
   Do not paste `.env` contents, API keys, signed URLs, JWTs, refresh tokens, or encrypted credential payloads into tickets or tracker notes.

4. Recover the dependency first.
   If Redis or Postgres is unavailable, fix that before restarting dependent services.

5. Restart only the affected service when possible.
   Restarting execution service clears in-memory market streams, user streams, account cache, and symbol cache. Restarting event service disconnects WebSocket clients. Restarting backend interrupts API requests.

6. Verify health and user-facing behavior.
   Use health checks before any live testnet action.

## Local Recovery Commands

Start services locally:

```sh
npm run dev:frontend
npm run dev:backend
npm run dev:event
npm run dev:execution
```

Backend expected startup behavior:

- Requires `REDIS_URL`.
- Requires `JWT_SECRET` through JWT module import.
- Requires `ENCRYPTION_KEY` through credential crypto module import.
- Connects Redis before listening.

Event service expected startup behavior:

- Uses `REDIS_URL`; current code defaults to `redis://127.0.0.1:6379` when unset.
- Uses `JWT_SECRET` to verify authenticated HTTP and WebSocket access.
- Starts HTTP/WebSocket server, Redis publisher, and Redis subscriber.

Execution service expected startup behavior:

- Requires `REDIS_URL`.
- Requires `ENCRYPTION_KEY` with exactly 32 characters.
- Connects Prisma, Redis subscriber, and Redis publisher.
- Starts market stream handling after boot.

## Verification Checks

- Backend `/health` returns ok.
- Event service `/health` returns ok.
- Execution service logs show Redis subscription startup and no fatal environment errors.
- Frontend can load and reach configured backend/event service URLs.
- Scoped account/order events are delivered only to authenticated matching users.
- No recovery logs contain secrets or signed URLs.

## Risks

- Restarting event service disconnects current WebSocket clients.
- Restarting execution service can interrupt order/account stream processing and market streams.
- If `ENCRYPTION_KEY` differs from the value used to encrypt existing credentials, decryption will fail.
- Binance Spot Testnet issues can look like service failures; verify dependency class before changing code.

## Pending Implementation-Dependent Work

- Add production or VPS process-manager commands after deployment files or PM2 ecosystem config are committed.
- Add rollback links once releases are tracked.
- Add dashboard links and escalation contacts after the project dashboard runbook section is updated.
- Add deterministic smoke tests for auth, order gateway, event scoping, and execution queue behavior.
