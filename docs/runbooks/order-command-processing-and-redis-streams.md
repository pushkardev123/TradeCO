# Order Command Processing and Redis Streams

Status: Backend Redis Stream producer and execution stream consumer are implemented for submit, query/open local state, cancel, and cancel-all. Backend still dual-writes submit Pub/Sub during transition, but execution treats Pub/Sub as fallback-only. Cancel commands are stream-only.

Tracker row: https://www.notion.so/3608ea2b3f8a81ff8e58dbde4c5b164a

## Owner

Primary owner: Backend/API owner.

Backup owner: Execution service owner.

## Scope

Use this runbook for order command processing incidents. The target architecture is:

```text
Frontend -> Backend API -> OrderCommand -> Redis Stream -> Execution Service -> Event Service
```

Current implementation note:

- Backend `POST /orders` persists `OrderCommand`, appends the v1 order submit entry to `ORDER_COMMAND_STREAM`, and then publishes JSON to the Redis Pub/Sub channel configured by `COMMANDS_CHANNEL`, defaulting to `commands:order:submit`.
- Backend `GET /orders/:orderId` returns one authenticated user's local order plus `OrderEvent` history.
- Backend `GET /orders/open?symbol=BTCUSDT` returns local open lifecycle rows for the authenticated user.
- Backend `DELETE /orders/:orderId` persists `CANCEL_REQUESTED`, appends `order.cancel.requested.v1`, and returns `202`.
- Backend `DELETE /orders/open?symbol=BTCUSDT` persists `CANCEL_REQUESTED` for matching local open orders, appends `order.cancel_all.requested.v1`, and returns `202`.
- If stream append fails after the database create, backend marks the command `STREAM_APPEND_FAILED` when possible and returns `503`. Do not expect the legacy Pub/Sub publish in that failure path.
- If cancel stream append fails after lifecycle state is persisted, backend marks affected local commands `CANCEL_APPEND_FAILED` and returns `503`.
- Duplicate submissions with the same authenticated user, `orderId`, and order intent return the existing command response without appending another stream entry. A duplicate for a command in `STREAM_APPEND_FAILED` retries the stream append.
- Execution service consumes `ORDER_COMMAND_STREAM` with consumer group `ORDER_COMMAND_CONSUMER_GROUP` and only subscribes to the legacy Pub/Sub command channel when `LEGACY_COMMANDS_CHANNEL_ENABLED=true`.
- Execution service processes cancel with Binance Spot Testnet `DELETE /api/v3/order` and cancel-all with `DELETE /api/v3/openOrders`, then persists `OrderCommand` / `OrderEvent` state and publishes scoped status events.
- Event service rejects public `POST /orders` ingress with `410` and tells callers to use the backend API.
- The committed stream contract lives in `packages/redis-stream-contracts` and is documented in [Redis Stream Contracts](../architecture/redis-stream-contracts.md).

## Current Dual-Write Triage Procedure

1. Confirm backend accepted the command.
   Verify the request used a valid Bearer token and did not rely on frontend-supplied `userId`.

2. Confirm `OrderCommand` exists.
   Check the backend database for the internal `orderId`, authenticated `userId`, symbol, side, type, quantity, and status. Do not expose credentials while querying.

3. Confirm backend appended the command stream entry.
   Inspect `ORDER_COMMAND_STREAM`, defaulting to `tradeco:orders:commands:v1`, for an entry with the `orderId` and authenticated `userId`. Backend stream append failures should leave the persisted command in `STREAM_APPEND_FAILED` when the status update succeeds.

4. Confirm execution service is consuming the stream.
   Execution logs should show `consuming stream: tradeco:orders:commands:v1 group=tradeco:execution:orders:v1`. Inspect pending entries with Redis stream tooling before replaying anything manually.

5. Confirm legacy fallback state.
   `LEGACY_COMMANDS_CHANNEL_ENABLED` should normally be `false` to avoid duplicate processing while backend dual-writes. Enable it only as an explicit rollback/fallback path if stream consumption is disabled.

6. Confirm credential decrypt succeeded.
   If the command is rejected because credentials cannot load or decrypt, follow [Credential Safety and Testnet Key Rotation](credential-safety-and-key-rotation.md) only when key material is invalid or exposed.

7. Confirm user-scoped event publication.
   Execution service publishes order status to `EVENTS_CHANNEL`, defaulting to `events:order:status`. Event service forwards scoped order updates only when the message contains a `userId` matching the authenticated WebSocket client.

## Core Lifecycle API Checks

Use a valid access token for all requests. Do not include `userId` or `user_id` in params, query strings, bodies, or nested metadata.

```sh
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$BACKEND_URL/orders/$ORDER_ID"

curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$BACKEND_URL/orders/open?symbol=BTCUSDT"

curl -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$BACKEND_URL/orders/$ORDER_ID"

curl -X DELETE -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$BACKEND_URL/orders/open?symbol=BTCUSDT"
```

Expected local lifecycle statuses:

| Phase | Statuses |
| --- | --- |
| Submit accepted locally | `RECEIVED`, `PENDING` |
| Exchange acknowledged/open | `SUBMITTED`, `PARTIALLY_FILLED` |
| Cancel requested | `CANCEL_REQUESTED`, `CANCEL_PENDING` |
| Cancel failed before/during execution | `CANCEL_APPEND_FAILED`, `CANCEL_REJECTED` |
| Terminal | `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED` |

## Verification Checks

- Backend order request derives user identity from the verified access token.
- Redis Stream entries use `schemaVersion: 1` and one of `order.submit.requested.v1`, `order.cancel.requested.v1`, or `order.cancel_all.requested.v1`.
- Submit stream entries use decimal strings for quantity, price, and stop price.
- Cancel stream entries include the backend-authenticated `userId`, internal `orderId`, and symbol; cancel-all stream entries include backend-authenticated `userId` and symbol.
- Local Redis Stream smoke passes:

  ```sh
  npm run smoke:p2-redis-stream
  ```

- Local market-order vertical-slice smoke passes:

  ```sh
  npm run smoke:p2-market-order
  ```

- Event service does not accept public order placement commands.
- Order command and latest order event share the expected `orderId` and `userId`.
- Cancel and cancel-all tests use mocks and must not require live Binance credentials.
- Logs do not contain API keys, signed URLs, JWTs, refresh tokens, or decrypted credential values.

## Risks

- Backend still dual-writes Pub/Sub until cleanup. If execution legacy fallback is enabled while stream consumption is also active, duplicate processing races are possible.
- Current order quantities and prices use JavaScript numbers and Prisma `Float`; decimal-safe storage is still a priority risk.
- Current execution service catches and suppresses some persistence errors during command handling; diagnostics can be incomplete.

## Redis Streams Contract

Committed names:

| Purpose | Name |
| --- | --- |
| Order command stream | `tradeco:orders:commands:v1` |
| Order command dead-letter stream | `tradeco:orders:commands:dlq:v1` |
| Order event stream | `tradeco:orders:events:v1` |
| Execution consumer group | `tradeco:execution:orders:v1` |

The v1 order lifecycle message types are `order.submit.requested.v1`, `order.cancel.requested.v1`, and `order.cancel_all.requested.v1`. The backend must derive `userId` from the verified access token, persist lifecycle state, and then append a sanitized stream entry. Trading numeric values must be positive decimal strings, not JavaScript numbers.

Idempotency keys:

- `commandId`: stable stream-processing idempotency key.
- `orderId`: backend-created order id persisted before stream append.

Dead-letter message type: `order.command.dead_lettered.v1`.

## Redis Streams Runtime Procedure

Use these steps after `npm run smoke:p2-redis-stream` passes against the same Redis environment.

Inspect the consumer group:

```sh
redis-cli XINFO GROUPS tradeco:orders:commands:v1
redis-cli XPENDING tradeco:orders:commands:v1 tradeco:execution:orders:v1
```

Inspect pending message details:

```sh
redis-cli XPENDING tradeco:orders:commands:v1 tradeco:execution:orders:v1 - + 10
```

Inspect dead-lettered messages:

```sh
redis-cli XRANGE tradeco:orders:commands:dlq:v1 - + COUNT 10
```

Before retrying a stuck command:

- Confirm the `orderId` in `OrderCommand`.
- Confirm the command is not already `SUBMITTED`, `PARTIALLY_FILLED`, or `FILLED`.
- Confirm there is no `binanceOrderId` for that `orderId`.
- Keep `LEGACY_COMMANDS_CHANNEL_ENABLED=false` unless this is an explicit rollback.

Only replay or manually acknowledge messages after those idempotency checks are complete.
