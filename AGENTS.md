# AGENTS.md

This file applies to the entire repository.

## Project Context

TradeCO is a Binance Spot Testnet trading application being rebuilt into a full test-server trading platform, with a future mobile application planned after the web/API contracts stabilize.

Current monorepo services:

- `apps/frontend`: Next.js trading terminal UI.
- `apps/backend`: Express API, authentication, database ownership, encrypted exchange credentials, and command gateway.
- `apps/event-service`: WebSocket realtime gateway for scoped user updates.
- `apps/execution-service`: Binance Spot Testnet integration and asynchronous order execution.

The Notion project dashboard and tracker are the planning source of truth:

- Dashboard: https://www.notion.so/3588ea2b3f8a811eb99bf000b77a72ae
- Master Execution Plan and Tracker: https://www.notion.so/3608ea2b3f8a8156aee1df3d61b3daa0
- Master Execution Tracker DB: https://www.notion.so/a84ff80a63154c04bd842758480eea05

## Target Architecture

Confirmed order command flow:

```text
Frontend
  -> Backend API verifies JWT, validates request, persists OrderCommand
  -> Backend appends command to Redis Stream
  -> Execution Service consumes stream asynchronously
  -> Event Service broadcasts scoped realtime updates
```

The backend is the authoritative command gateway. The event service must not accept public order placement commands.

## Non-Negotiables

- This project is testnet-only. Do not add production trading endpoints unless the tracker explicitly scopes that work.
- Never commit secrets, API keys, refresh tokens, signatures, `.env` files, or generated credential material.
- Treat Binance Testnet API keys as secrets even though they are testnet credentials.
- Remove existing hardcoded Binance keys and module import side effects before building on top of exchange code.
- User identity must come from verified access tokens. Do not trust `userId` supplied by frontend request bodies, query params, or WebSocket messages.
- Users bring their own Binance Testnet API keys during signup/onboarding. Store exchange credentials encrypted in a separate `ExchangeCredential` model, not directly on `User`.
- Authentication target is short-lived JWT access tokens plus opaque rotating refresh tokens.
- Web access tokens should not be persisted in `localStorage`. Use in-memory access tokens where feasible and an httpOnly secure refresh cookie when domain setup allows.
- Mobile should follow the same access/refresh model later, storing refresh tokens in platform secure storage such as Keychain/SecureStore.
- Store only hashed refresh tokens server-side.
- Use Redis Streams for durable order command processing. Use Pub/Sub only for ephemeral fanout if needed.
- Use decimal/string-safe handling for prices, quantities, balances, fills, and notional values. Avoid JavaScript float math for trading calculations.
- Sanitize logs. Never log API keys, signatures, JWTs, refresh tokens, or decrypted credential payloads.

## Service Responsibilities

### Frontend

- Owns user-facing trading workflows, auth screens, market views, order forms, portfolio views, and realtime UI state.
- Must call backend APIs for authenticated business actions.
- Must not call Binance directly.
- Must not send `userId` as authority for authenticated actions.
- Should use the brand direction from Notion: dark professional trading terminal, compact dense layout, neutral zinc/black base, semantic green/red, restrained amber/cyan accents.

### Backend

- Owns authentication, refresh-token rotation, authorization, request validation, persistence, exchange credential encryption, and Redis Stream command append.
- Must validate order commands before persistence and stream append.
- Must derive user scope from the verified access token.
- Must keep exchange credential storage separate from user account identity.

### Event Service

- Owns scoped WebSocket delivery to authenticated users.
- Must authenticate WebSocket clients before subscribing them to user-specific channels.
- Must broadcast only data the connected user is allowed to see.
- Must not provide unauthenticated `/orders` or account-info command ingress.

### Execution Service

- Owns Redis Stream consumption, Binance Spot Testnet API calls, order state reconciliation, and market/user stream ingestion.
- Must use Binance Spot Testnet endpoints.
- Should migrate away from deprecated listen-key user data stream flows and use the current Binance WebSocket API/user data stream approach documented by Binance.
- Must be idempotent around command processing, retries, and duplicate delivery.

## Local Setup

Install dependencies:

```sh
npm install
```

Run services:

```sh
npm run dev:frontend
npm run dev:backend
npm run dev:event
npm run dev:execution
```

Useful frontend verification:

```sh
npm --workspace apps/frontend run lint
npm --workspace apps/frontend run build
```

When touching Prisma schemas, run validation/generation from the service that owns the schema:

```sh
npx prisma validate
npx prisma generate
```

If a command cannot run because Redis, Postgres, Binance credentials, or environment variables are unavailable, state the exact blocker in the final response.

## Environment

Backend requires:

- `DATABASE_URL`
- `JWT_SECRET`
- `ENCRYPTION_KEY` with 32 characters
- `REDIS_URL`

Event service requires:

- `REDIS_URL`
- `DATABASE_URL` if database access is used by the task

Execution service requires:

- `REDIS_URL`
- `DATABASE_URL`
- `ENCRYPTION_KEY` when decrypting stored exchange credentials
- Binance Testnet API/stream base URLs when not using defaults

Frontend currently uses public URL configuration such as:

- `NEXT_PUBLIC_BACKEND_URL`
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_EVENT_SERVICE_URL`
- `NEXT_PUBLIC_WS_URL`
- Optional market rendering settings such as `NEXT_PUBLIC_MARKET_FLUSH_MS` and `NEXT_PUBLIC_MAX_SYMBOLS`

Do not invent secret defaults in code. Fail clearly when required configuration is missing.

## Codex Cloud Workflow

- Use the Notion Master Execution Tracker as the work queue and decision record.
- Prefer one tracker item per branch/PR.
- Use branch names beginning with `codex/` unless the user requests another prefix.
- Keep each task narrow and tied to a tracker row.
- Update the tracker fields when work progresses: status, owner, branch, PR link, review status, QA status, blockers, notes, and dates.
- Do not mark tracker items complete until implementation and verification are both done.
- If implementation reveals a scope change, update Notion before continuing with unrelated work.
- Leave PR Link blank until a PR actually exists.

## PR Expectations

Each PR should include:

- Tracker item or Notion link.
- Summary of behavior changed.
- Verification commands and results.
- Migration notes, if schema or environment changes are included.
- Rollback notes for risky backend/execution changes.
- Known limitations or blocked verification.

## Verification Expectations

- Run relevant verification before finishing a task.
- For frontend changes, run lint and build when practical.
- For auth, database, or Prisma changes, run schema validation/generation and targeted service smoke checks when environment permits.
- For Redis/Binance pipeline changes, prefer deterministic tests or mocks. Do not require live Binance calls unless the task explicitly asks for live testnet verification and credentials are available.
- For security-sensitive work, include a short manual checklist covering token storage, user scoping, secret handling, and log sanitization.

## Coding Standards

- Follow the existing JavaScript/Node style unless a tracker item explicitly introduces TypeScript or a framework change.
- Keep edits scoped to the service and feature being changed.
- Avoid unrelated refactors, broad formatting churn, and dependency additions that are not needed for the task.
- Prefer small local helpers over large abstractions until repeated behavior is clear.
- Add comments only when they explain non-obvious security, trading, or concurrency behavior.
- Do not silently swallow errors in auth, order execution, credential handling, or stream processing.

## Current Priority Risks

Address these early in the execution plan:

- Hardcoded Binance Testnet credentials and import-time exchange calls in backend exchange code.
- Public routes that trust client-supplied `userId`.
- Token/user identity persisted in frontend `localStorage`.
- Event service acting as an unauthenticated order ingress.
- Deprecated Binance listen-key stream usage.
- Float-based handling of prices, quantities, balances, or notional values.

