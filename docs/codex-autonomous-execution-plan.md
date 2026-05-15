# Codex Autonomous Execution Plan

Last updated: 2026-05-16 03:03 IST

## Purpose

This file is the local execution ledger for the TradeCO rebuild. It exists so long-running autonomous work can recover safely after context compaction, connection drops, or tool interruptions.

The Notion Master Execution Tracker remains the planning source of truth. This file records the local working sequence, verification evidence, commits, and handoff notes.

## Current Baseline

- Branch: `main`
- Remote: `origin/main`
- Current pushed commit: `b7d62b0` (`Replace trading floats with decimals`)
- Docker Compose stack: verified running with frontend, backend, event service, execution service, Postgres, Redis, and migration container.
- Local deploy command: `npm run deploy:compose:up`
- Local app URLs:
  - Frontend: `http://127.0.0.1:3000/trade`
  - Backend health: `http://127.0.0.1:8080/health`
  - Event health: `http://127.0.0.1:8081/health`

## Completed During This Autonomous Run

| Commit | Notion item | Result |
| --- | --- | --- |
| `4c2237a` | Add Docker Compose local stack | One-command Docker stack, deployment docs, nginx sample, PM2 config, production env template, frontend build font fix. |
| `9ce4698` | Extract Binance client module | Centralized Binance Spot Testnet REST client, signing, safe errors, rate-limit metadata, execution-service refactor. |
| `b7d62b0` | Replace Float math with Decimal/string-safe trading values | Prisma Decimal migration, normalized decimal string service boundaries, Decimal-safe execution/account/position math, full compose verification. |

## Working Rules

- Work from `main` unless a task requires an isolated branch.
- Keep each task mapped to one Notion tracker row.
- Update Notion before starting a row, after verification, and after push.
- Prefer narrow commits with direct verification notes.
- Do not commit `.env`, `.env.deploy`, secrets, API keys, generated credential material, or screenshots containing secrets.
- Keep Binance endpoints testnet-only unless Notion explicitly changes scope.
- Run service-specific tests plus relevant smoke checks before marking a row done.
- If a live Binance credential is required and unavailable, verify with deterministic tests/mocks and record the exact blocker.

## Verification Command Pool

Use the smallest safe set for each task, then expand when touching shared or deploy surfaces.

```sh
npm --workspace apps/backend run test:auth
npm --workspace apps/event-service run test:auth
npm --workspace apps/execution-service run test
npm run test:stream-contracts
REDIS_URL=redis://127.0.0.1:6379 npm run smoke:p2-redis-stream
REDIS_URL=redis://127.0.0.1:6379 npm run smoke:p2-market-order
npm --workspace apps/frontend run lint
set -a; source .env.deploy; set +a; npm --workspace apps/frontend run build
npm run deploy:compose:config
npm run deploy:compose:up
curl -i http://127.0.0.1:8080/health
curl -i http://127.0.0.1:8081/health
curl -I http://127.0.0.1:3000/trade
git diff --check HEAD
```

## Provisional Remaining Sequence

This sequence will be reconciled against Notion before each item starts.

| Order | Notion item | Reason |
| --- | --- | --- |
| 1 | Replace Float math with Decimal/string-safe trading values | High trading correctness risk; foundation for validations, reconciliation, and advanced order types. |
| 2 | Add order and account reconciliation worker | Needed for reliable execution state after async processing or service restarts. |
| 3 | Add event contract tests | Locks frontend/event payload compatibility before expanding realtime features. |
| 4 | Broadcast scoped order and account events | Builds on event contracts and existing scoped auth. |
| 5 | Migrate user data stream to current WebSocket API flow | Binance stream correctness and deprecation risk; may need docs verification. |
| 6 | Implement full Binance filter and risk validation layer | Depends on string-safe decimal work and exchange info client support. |
| 7 | Add advanced single order types | Product expansion after validation layer is safer. |
| 8 | Add order book and trade tape | Frontend/realtime expansion after event contracts stabilize. |
| 9 | Create shared API and domain contract packages | Useful once contracts have settled from backend/event/execution work. |
| 10 | Add structured logging and observability baseline | Cross-cutting hardening after core flows stabilize. |
| 11 | Create production technical presentation and app overview | Final manager/developer narrative after implementation state is stable. |

## Active Task Log

### Active: Replace Float math with Decimal/string-safe trading values

- Notion page: `3608ea2b-3f8a-817f-b54b-fd5355b59976`
- Status at start: `Not started`, `P0`, high risk.
- Branch: `main`
- Started: 2026-05-16 02:45 IST
- Goal: remove unsafe JS float persistence/calculation paths for trading quantities, prices, notionals, fills, and balances where feasible.
- Implementation:
  - Converted persisted order, order event, and position trading values from Prisma `Float` to `Decimal @db.Decimal(36, 18)`.
  - Added migration `20260516000000_decimal_trading_values`.
  - Kept backend, Redis command, execution-service, Binance response, account balance, and public API trading values as normalized decimal strings.
  - Replaced position fill math, average fill price math, account balance totals, duplicate-intent comparison, and Binance price/stopPrice validation with Decimal helpers.
- Verification:
  - `npx prisma validate --schema apps/backend/prisma/schema.prisma` with local `DATABASE_URL`: pass.
  - `npx prisma generate --schema apps/backend/prisma/schema.prisma` with local `DATABASE_URL`: pass.
  - `npm --workspace apps/backend run test`: pass.
  - `npm --workspace apps/execution-service run test`: pass.
  - `npm run test:stream-contracts`: pass.
  - `npm --workspace apps/frontend run lint`: pass with existing hook dependency warnings.
  - `npm --workspace apps/frontend run build`: pass when run outside sandbox with required `NEXT_PUBLIC_*` env vars.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --build`: pass.
  - Compose migration log: `20260516000000_decimal_trading_values` applied successfully.
  - Compose Postgres schema check: 13 trading columns are `numeric(36,18)`.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `npm run smoke:p0-auth-boundary`: pass.

### Active: Add order and account reconciliation worker

- Notion page: `3608ea2b-3f8a-8135-8894-c8b5736c4939`
- Status at start: `Not started`, `P1`, medium risk.
- Branch: `main`
- Started: 2026-05-16 03:00 IST
- Goal: recover order/account state after missed Binance websocket events, execution-service restarts, or stale local order rows.
- Implementation:
  - Added signed Binance read methods for order query, open orders, all orders, and my trades.
  - Added execution-service reconciliation worker with configurable enabled/interval/stale/batch settings.
  - Reconciles stale local open/in-flight orders against Binance order state, backfills fill quantities/prices, creates scoped order events, and publishes recovery events.
  - Publishes account balance snapshots for users touched by reconciliation.
  - Added deterministic mocked tests; no live Binance credentials required for QA.
- Verification:
  - `npm --workspace apps/execution-service run test`: pass.
  - `node --check apps/execution-service/src/index.js`: pass.
  - `node --check apps/execution-service/src/reconciliationWorker.js`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml config --quiet`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --build`: pass.
  - Execution-service Docker log shows reconciliation enabled with interval `60000`, stale window `30000`, batch size `100`.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `npm run smoke:p0-auth-boundary`: pass.
