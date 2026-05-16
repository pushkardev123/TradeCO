# Codex Autonomous Execution Plan

Last updated: 2026-05-16 09:53 IST

## Purpose

This file is the local execution ledger for the TradeCO rebuild. It exists so long-running autonomous work can recover safely after context compaction, connection drops, or tool interruptions.

The Notion Master Execution Tracker remains the planning source of truth. This file records the local working sequence, verification evidence, commits, and handoff notes.

## Current Baseline

- Branch: `main`
- Remote: `origin/main`
- Current local commit: `a7ad07d` (`Add advanced single order support`)
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
| `86eeb2e` | Add order and account reconciliation worker | Stale order reconciliation, signed Binance read methods, account snapshot publishing, deterministic tests, compose verification. |
| `431455d` | Add event contract tests | Shared realtime channel/payload contract tests for Redis Pub/Sub and WebSocket envelopes. |
| `352367a` | Broadcast scoped order and account events | Event-service contract-backed private fanout, runtime channel override validation, and full rejected-order realtime payloads. |
| `5c5314b` | Migrate user data stream to current WebSocket API flow | Binance WebSocket API user stream subscription, signed request helper, reconnect handling, env/deploy docs, and removal of old REST stream-key path. |
| `cff1027` | Record user stream migration completion | Ledger-only commit after user-stream migration. |
| `5aaea86` | Implement full Binance filter and risk validation layer | Shared decimal-safe Binance filter validation, backend/execution enforcement before submission, field-level errors, and deploy-path verification. |
| `f7c5dfe` | Add environment validation and startup config checks; Create runbooks for operations and testnet reset handling | Added deploy env preflight validation, caught/fixed local Postgres role-length startup failure, verified clean Compose recovery, health endpoints, tests, and Redis smokes. |
| `44c8482` | Create shared API and domain contract packages | Added framework-free API/domain contracts package, moved backend DTO/status constants and frontend realtime/order constants onto shared contracts, verified service tests, frontend build, Compose rebuild, and smokes. |
| `c96679b` | Add reconnect and replay behavior | Frontend now refreshes backend snapshots, resubscribes chart state, tracks reconnect attempts, and exposes realtime replay state after websocket reconnect or tab/mobile resume. |
| `a7ad07d` | Add advanced single order types | Added quote-sized market orders, STOP_LOSS_LIMIT, TAKE_PROFIT, TAKE_PROFIT_LIMIT, and LIMIT_MAKER support through shared contracts, backend validation/persistence, execution request building, frontend controls, and Prisma migration. |

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
| 7 | Add order book and trade tape | Frontend/realtime expansion after event contracts stabilize. |
| 8 | Add structured logging and observability baseline | Cross-cutting hardening after core flows stabilize. |
| 9 | Create production technical presentation and app overview | Final manager/developer narrative after implementation state is stable. |

## Active Task Log

### Completed: Replace Float math with Decimal/string-safe trading values

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

### Completed: Add order and account reconciliation worker

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

### Completed: Add event contract tests

- Notion page: `3608ea2b-3f8a-81c1-a0c8-e2f203dba901`
- Status at start: `Not started`, `P1`, medium risk.
- Branch: `main`
- Started: 2026-05-16 03:07 IST
- Goal: lock Redis Pub/Sub and WebSocket payload shapes before expanding realtime features.
- Implementation:
  - Added realtime event contract definitions for canonical channels, scoped channels, event type names, payload validators, and WebSocket `REDIS_EVENT` envelope validation.
  - Covered order status, account balances, account info request/response, symbol info request/response, market price board/update, chart subscribe/unsubscribe, and kline snapshot/update events.
  - Documented the contract test location in README near the account/balance contract note.
- Verification:
  - `npm run test:stream-contracts`: pass.
  - `npm --workspace apps/event-service run test`: pass.
  - `npm --workspace apps/execution-service run test`: pass.
  - `node --check packages/redis-stream-contracts/src/realtimeEventContracts.js`: pass.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `git diff --check`: pass.

### Completed: Broadcast scoped order and account events

- Notion page: `3608ea2b-3f8a-8174-9ad7-db072df78a2e`
- Status at start: `Not started`, `P1`, medium risk.
- Branch: `main`
- Started: 2026-05-16 03:10 IST
- Goal: harden event-service broadcasts so private order/account Redis messages are contract-validated and delivered only as scoped, authenticated WebSocket events.
- Implementation:
  - Added event-service dependency on shared Redis/WebSocket realtime contracts.
  - Added `broadcastContracts` helper and tests to validate scoped Redis payloads and emitted WebSocket envelopes.
  - Updated event-service fanout to reject invalid/private payload shapes before broadcasting.
  - Extended contract validation to support runtime channel overrides from environment variables.
  - Updated execution-service order rejection publishing to emit the full order status event shape expected by the realtime contract.
- Verification:
  - `npm run test:stream-contracts`: pass.
  - `npm --workspace apps/event-service run test`: pass.
  - `npm --workspace apps/execution-service run test`: pass.
  - `node --check apps/event-service/src/index.js`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml config --quiet`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --build`: pass.
  - Event-service Docker logs show successful startup and Redis subscriptions.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `git diff --check`: pass.

### Completed: Migrate user data stream to current WebSocket API flow

- Notion page: `3608ea2b-3f8a-81a5-a44a-e440eb7ac721`
- Status at start: `Not started`, `P0`, high risk.
- Branch: `main`
- Started: 2026-05-16 03:20 IST
- Goal: remove deprecated REST stream-key management and subscribe to Binance Spot Testnet user data events through the current WebSocket API flow.
- Binance docs checked:
  - WebSocket API base for Spot Testnet: `wss://ws-api.testnet.binance.vision/ws-api/v3`.
  - User data stream subscription method: `userDataStream.subscribe.signature`.
- Implementation:
  - Added WebSocket API user data stream helper for Testnet URL validation, signed subscribe/unsubscribe request building, HMAC/asymmetric signing support, subscription acknowledgement parsing, and wrapped event extraction.
  - Updated execution-service user stream startup to connect to `BINANCE_WS_API_BASE`, send a signed subscription request, process wrapped account/order events, and reconnect after unexpected closes.
  - Removed REST stream-key create/keepalive/close client methods and all execution-service usage of that old flow.
  - Added `BINANCE_WS_API_BASE` to execution-service config, Docker Compose deploy env, and env/docs examples.
  - Updated task guidance/docs so future agents do not reintroduce the old stream-key path.
- Verification:
  - `npm --workspace apps/execution-service run test`: pass.
  - `node --check apps/execution-service/src/index.js`: pass.
  - `node --check apps/execution-service/src/binanceUserDataStream.js`: pass.
  - No legacy stream-key identifiers or REST user-data-stream path remains in code/docs: pass.
  - `npm run test:stream-contracts`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml config --quiet`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --build`: pass.
  - Execution-service Docker logs show `binanceWsApiBase` set to Spot Testnet WebSocket API and market stream connected.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `git diff --check`: pass.
- Verification limitation:
  - Live Binance user data subscription was not opened during automated QA because no seeded encrypted user Testnet credential was exercised in the smoke harness. The signed request builder, event envelope parser, reconnect path, Docker startup, and order/account event handlers are covered deterministically.

### Completed: Implement full Binance filter and risk validation layer

- Notion page: `3608ea2b-3f8a-81a5-b368-e1bbaf30f97a`
- Status at start: `Ready`, `P1`, high risk.
- Branch: `main`
- Started: 2026-05-16 05:04 IST
- Goal: block invalid orders before Binance submission using the same decimal-safe exchange filter rules in backend and execution service.
- Binance docs checked:
  - Official Spot API filters: `PRICE_FILTER`, `LOT_SIZE`, `MARKET_LOT_SIZE`, `MIN_NOTIONAL`, `NOTIONAL`, `MAX_NUM_ORDERS`, `MAX_NUM_ALGO_ORDERS`, and `MAX_POSITION`.
- Implementation:
  - Added shared Binance filter normalization and validation in `packages/redis-stream-contracts`.
  - Validates price tick/min/max, quantity min/max/step, market lot size, min/max notional, and optional max-order/max-position context without JavaScript float math.
  - Backend now fetches/caches public `exchangeInfo`, uses `avgPrice` for market-style notional checks, and returns field-level 400 errors before persistence/Redis append.
  - Execution service repeats shared filter validation before loading credentials, starting user streams, or submitting to Binance.
  - Binance client now exposes public average price and retains raw symbol filters for validation.
  - Runbook and stream contract docs now document filter validation and cache behavior.
- Verification:
  - `npm run test:stream-contracts`: pass.
  - `npm --workspace apps/backend run test`: pass.
  - `npm --workspace apps/execution-service run test`: pass.
  - `node --check packages/redis-stream-contracts/src/binanceFilterValidation.js`: pass.
  - `node --check apps/backend/src/binanceExchangeFilters.js`: pass.
  - `node --check apps/execution-service/src/index.js`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml config --quiet`: pass.
  - `docker compose --env-file .env.deploy -f docker-compose.deploy.yml up -d --build`: pass.
  - Backend/execution-service Docker logs show clean startup.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `git diff --check`: pass.

### Completed: Add environment validation and startup config checks

- Notion page: `3608ea2b-3f8a-81e5-b869-c31dfb67a901`
- Status at start: `QA`, `P0`, medium risk.
- Branch: `main`
- Completed: 2026-05-16 09:12 IST
- Commit: `f7c5dfe` (`Add deploy env preflight validation`)
- Goal: close the remaining startup/env QA by proving the deploy stack fails clearly and starts reliably with valid env.
- Finding:
  - Local Compose startup initially failed because the existing Postgres volume was initialized with older credentials.
  - After resetting the local Compose volumes, Postgres still failed because the generated `TRADECO_POSTGRES_USER` exceeded PostgreSQL's 63-byte role-name limit.
- Implementation:
  - Added `scripts/validate-deploy-env.mjs`.
  - Added `npm run deploy:compose:check-env`.
  - Wired the preflight before `deploy:compose:config` and `deploy:compose:up`.
  - Validates required deploy secrets, `ENCRYPTION_KEY` length, Postgres identifier lengths, bundled Postgres `DATABASE_URL` consistency, Redis URL shape, frontend/public URL shape, and Binance Testnet-only endpoints.
  - Updated `.env.deploy.example` and `docs/deployment.md` with bundled Postgres and role-name guidance.
  - Repaired local `.env.deploy` username without printing secrets.
- Verification:
  - `npm run deploy:compose:check-env`: failed before local env repair with the expected Postgres role-length error.
  - `npm run deploy:compose:check-env`: pass after local env repair.
  - `npm run deploy:compose:up`: pass after clean local Compose volume reset.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `npm run test:stream-contracts`: pass.
  - `npm --workspace apps/backend run test`: pass.
  - `npm --workspace apps/execution-service run test`: pass.
  - `npm --workspace apps/event-service run test`: pass.
  - `npm --workspace apps/frontend run lint`: pass with existing hook dependency warnings only.
  - `git diff --check`: pass.

### Completed: Create runbooks for operations and testnet reset handling

- Notion page: `3608ea2b-3f8a-81ff-8e58-dbde4c5b164a`
- Status at start: `In review`, `P2`, low risk.
- Branch: `main`
- Completed: 2026-05-16 09:12 IST
- Commit: `f7c5dfe` (`Add deploy env preflight validation`)
- Goal: validate the runbooks against a real local stack recovery/reset flow.
- Result:
  - Exercised local Compose recovery after database credential/initialization failure.
  - Verified that the documented local stack reset path works.
  - Added deploy preflight validation so future operators get a clear env error before Docker initializes broken local state.
- Verification:
  - Same clean Compose startup, health checks, service tests, and Redis smokes listed in the environment validation task above.

### Completed: Create shared API and domain contract packages

- Notion page: `3608ea2b-3f8a-81f5-a39b-c266b8ef62da`
- Status at start: `Not started`, `P1`, medium risk.
- Branch: `main`
- Completed: 2026-05-16 09:22 IST
- Commit: `44c8482` (`Add shared API contracts package`)
- Goal: establish framework-free API/domain contracts reusable by backend, frontend, and future mobile without broad refactoring.
- Implementation:
  - Added `@tradeco/api-contracts`.
  - Added shared API route constants, realtime channel defaults, order side/type/status constants, open/cancel status groups, DTO formatters, and response validators for orders, positions, balances, and auth context.
  - Backend now imports shared open-order/cancel status constants and order/event/position DTO formatting.
  - Frontend now imports shared realtime channel defaults and basic order-type choices.
  - Dockerfile and workspace lockfile now include the new package.
  - Updated `p0-auth-boundary` smoke to allow the frontend account-balance channel constant to come from the shared package.
- Verification:
  - `npm run test:api-contracts`: pass.
  - `npm --workspace apps/backend run test`: pass.
  - `npm --workspace apps/execution-service run test`: pass.
  - `npm --workspace apps/event-service run test`: pass.
  - `npm run test:stream-contracts`: pass.
  - `npm --workspace apps/frontend run lint`: pass with existing hook dependency warnings only.
  - `set -a; source .env.deploy; set +a; npm --workspace apps/frontend run build`: pass outside sandbox.
  - `npm run deploy:compose:up`: pass and rebuilt all app images.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `git diff --check`: pass.

### Completed: Add reconnect and replay behavior

- Notion page: `3608ea2b-3f8a-8116-a94b-fe6d492a3f4d`
- Status at start: `In progress`, `P1`, medium risk.
- Branch: `main`
- Completed: 2026-05-16 09:29 IST
- Commit: `c96679b` (`Add frontend reconnect replay recovery`)
- Goal: recover private frontend state after websocket reconnects, browser focus, or mobile/tab resume without weakening websocket authentication.
- Implementation:
  - Added frontend replay state for reconnect count, retry attempt, replay sync status, and last successful snapshot refresh.
  - On websocket open/reopen, refreshes balances, orders, positions, and active chart subscription state from backend snapshots.
  - On visibility/focus resume, replays the same backend snapshots and chart subscription.
  - Updated the terminal header realtime pill to expose live, syncing, reconnecting, auth, and offline states.
- Verification:
  - `npm --workspace apps/frontend run lint`: pass with existing hook dependency warnings only.
  - `set -a; source .env.deploy; set +a; npm --workspace apps/frontend run build`: pass outside sandbox.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `git diff --check`: pass.

### Completed: Add advanced single order types

- Notion page: `3608ea2b-3f8a-81fa-909a-cc3c8d6f672a`
- Status at start: `Not started`, `P2`, medium risk.
- Branch: `main`
- Completed: 2026-05-16 09:53 IST
- Commit: `a7ad07d` (`Add advanced single order support`)
- Goal: extend single-order support after the risk/filter layer so advanced Binance Spot Testnet order types submit through the same authenticated backend and Redis Stream command pipeline.
- Implementation:
  - Added first-class `quoteOrderQty` support for MARKET orders through stream contracts, API DTOs, backend drafts, Prisma persistence, execution normalization, and Binance request building.
  - Added migration `20260516093000_quote_order_qty`, making `OrderCommand.quantity` nullable and adding `OrderCommand.quoteOrderQty`.
  - Extended order-type rules for `STOP_LOSS_LIMIT`, `TAKE_PROFIT`, `TAKE_PROFIT_LIMIT`, and `LIMIT_MAKER`, including price/stopPrice/timeInForce validation and Binance request params.
  - Updated the frontend order ticket with advanced order tabs, quote-vs-base market sizing, stop/limit price controls, and time-in-force controls.
  - Added `NEXT_PUBLIC_ENABLE_ADVANCED_ORDERS` as a frontend feature flag and deploy env validation.
- Verification:
  - `npm run test:stream-contracts`: pass.
  - `npm run test:api-contracts`: pass.
  - `npm --workspace apps/backend run test`: pass.
  - `npm --workspace apps/execution-service run test`: pass.
  - `npm --workspace apps/event-service run test`: pass.
  - `npx prisma validate --schema apps/backend/prisma/schema.prisma` with local `DATABASE_URL`: pass.
  - `npx prisma generate --schema apps/backend/prisma/schema.prisma` with local `DATABASE_URL`: pass.
  - `npm --workspace apps/frontend run lint`: pass with existing hook dependency warnings only.
  - `set -a; source .env.deploy; set +a; npm --workspace apps/frontend run build`: pass outside sandbox.
  - `npm run deploy:compose:check-env`: pass.
  - `npm run deploy:compose:up`: pass and rebuilt all app images.
  - Migration log: `20260516093000_quote_order_qty` applied successfully.
  - Health checks: backend `200`, event-service `200`, frontend `/trade` `200`.
  - `npm run smoke:p0-auth-boundary`: pass.
  - `npm run smoke:p2-redis-stream`: pass outside sandbox against local Redis.
  - `npm run smoke:p2-market-order`: pass outside sandbox against local Redis.
  - `git diff --check`: pass.
- Verification limitation:
  - Browser automation tools were not available in this session and the Node REPL environment did not have Playwright installed, so visual verification was limited to production build, `/trade` HTTP 200, and code inspection.
