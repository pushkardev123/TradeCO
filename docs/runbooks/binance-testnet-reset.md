# Binance Testnet Reset Handling

Status: Initial structure. Sections that depend on unimplemented reset tooling are marked `Pending`.

Tracker row: https://www.notion.so/3608ea2b3f8a81ff8e58dbde4c5b164a

## Owner

Primary owner: Execution service owner.

Backup owner: Backend/API owner.

Manager responsibility: decide whether reset handling is a user-facing incident, whether local data should be preserved, and when QA can resume live testnet verification.

## Scope

Use this runbook when Binance Spot Testnet changes or resets state in a way that affects TradeCO test accounts, balances, symbols, order history, listen keys, or API keys.

This repo is testnet-only. Do not use production Binance endpoints while handling a testnet reset.

## Preconditions

- Access to the Binance Spot Testnet portal for the affected test account.
- Access to TradeCO service logs without exposing secrets.
- Access to restart backend, event service, and execution service in the affected environment.
- Current `REDIS_URL`, `DATABASE_URL`, and `ENCRYPTION_KEY` are available to the services that require them.

## Reset Response Procedure

1. Confirm the symptom.
   Use non-secret evidence first: error class, service name, endpoint path without query signature, affected user, and timestamp. Do not paste API keys, signed URLs, JWTs, or encrypted credential payloads into the tracker.

2. Pause live testnet QA.
   Stop manual tests that place orders or fetch account data until the manager or execution owner confirms the reset state.

3. Check whether credentials still work.
   An operator with valid credentials may verify in the Binance Spot Testnet portal. Documentation-only work must not call Binance.

4. Rotate credentials if keys were reset or invalidated.
   Follow [Credential Safety and Testnet Key Rotation](credential-safety-and-key-rotation.md).

5. Clear execution service process-local state.
   Restart execution service to clear in-memory user streams, account cache, symbol cache, and kline stream state. Current code keeps these in memory.

6. Decide how to handle local persisted state.
   Current app stores order and position records in the backend database. If Binance reset made local orders or balances misleading, mark the affected records in the incident notes and decide whether to preserve, archive, or reset them.

7. Resume controlled verification.
   Verify service health first, then account and order flows only with approved testnet credentials.

8. Update the tracker.
   Note the reset date, affected users or symbols, whether keys rotated, whether services restarted, and any local data action taken.

## Verification Checks

- Backend `/health` returns ok.
- Event service `/health` returns ok and reports Redis publisher/subscriber readiness.
- Execution service logs show Redis and database connection success after restart.
- No logs contain API keys, signatures, signed URLs, JWTs, refresh tokens, or decrypted credential payloads.
- If live testnet verification is approved, account-info and a minimal testnet-only order flow are verified by an authorized operator.

## Risks

- Binance Spot Testnet can reset balances and orders independently of local persisted state.
- Current code still uses listen-key user streams in execution service; reset behavior can invalidate active streams.
- Restarting execution service interrupts active market, account, and user streams.
- Local positions currently use JavaScript numbers and Prisma `Float`; reconciliation after a reset may be imprecise until decimal-safe storage is implemented.

## Pending Implementation-Dependent Work

- Define a database reset or archival script for orders, events, positions, and future credential records.
- Add a reconciliation command that compares local state with Binance Spot Testnet state without exposing secrets.
- Replace listen-key user stream handling with the current Binance WebSocket API/user data stream approach scoped in the tracker.
- Add exact production or VPS process-manager restart commands after deployment tooling is documented.
- Link this runbook from the Notion project dashboard after broader runbook scope is approved.
