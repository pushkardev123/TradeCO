# Redis Stream Contracts

Status: Contract committed. Backend producer dual-write and execution stream consumption are implemented; legacy Pub/Sub order processing is fallback-only.

Tracker row: https://www.notion.so/3608ea2b3f8a81c78c7ecd629dd7d34f

## Scope

This document defines the Redis Streams naming and message envelope for asynchronous order lifecycle processing. The backend imports `@tradeco/redis-stream-contracts` and appends authenticated submit, cancel, and cancel-all commands to the command stream. During the submit transition it still dual-writes the legacy Pub/Sub channel; cancel commands are stream-only. The execution service consumes the stream by default and only processes the legacy channel when `LEGACY_COMMANDS_CHANNEL_ENABLED=true`.

## Streams and Groups

| Purpose | Name |
| --- | --- |
| Order command stream | `tradeco:orders:commands:v1` |
| Order command dead-letter stream | `tradeco:orders:commands:dlq:v1` |
| Order event stream | `tradeco:orders:events:v1` |
| Execution consumer group | `tradeco:execution:orders:v1` |

Environment overrides:

| Variable | Default |
| --- | --- |
| `ORDER_COMMAND_STREAM` | `tradeco:orders:commands:v1` |
| `ORDER_COMMAND_DLQ_STREAM` | `tradeco:orders:commands:dlq:v1` |
| `ORDER_EVENT_STREAM` | `tradeco:orders:events:v1` |
| `ORDER_COMMAND_CONSUMER_GROUP` | `tradeco:execution:orders:v1` |
| `ORDER_COMMAND_READ_COUNT` | `10` |
| `ORDER_COMMAND_CLAIM_IDLE_MS` | `30000` |
| `ORDER_COMMAND_MAX_ATTEMPTS` | `5` |

## Order Submit Command

Message type: `order.submit.requested.v1`

Required fields:

| Field | Rule |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `messageType` | Must be `order.submit.requested.v1`. |
| `commandId` | Stable idempotency key for stream processing. |
| `orderId` | Backend-created order id from `OrderCommand`. |
| `userId` | Backend-derived authenticated user id. Never trust frontend-supplied authority. |
| `symbol` | Uppercase Binance symbol, for example `BTCUSDT`. |
| `side` | `BUY` or `SELL`. |
| `orderType` | Binance Spot order type supported by the contract. |
| `quantity` | Positive decimal string. Do not use JavaScript numbers. |
| `createdAt` | ISO-compatible timestamp. |
| `metadata` | JSON string in Redis, parsed as an object by consumers. |

Conditional fields:

| Field | Required when |
| --- | --- |
| `price` | `LIMIT`, `STOP_LOSS_LIMIT`, `TAKE_PROFIT_LIMIT`, or `LIMIT_MAKER`. Must be a positive decimal string. |
| `stopPrice` | `STOP_LOSS`, `STOP_LOSS_LIMIT`, `TAKE_PROFIT`, or `TAKE_PROFIT_LIMIT`. Must be a positive decimal string. |
| `timeInForce` | `LIMIT`, `STOP_LOSS_LIMIT`, or `TAKE_PROFIT_LIMIT`. Must be `GTC`, `IOC`, or `FOK`. |

Optional fields:

| Field | Rule |
| --- | --- |
| `requestId` | Request correlation id when available. |
| `source` | Defaults to `backend`. |

## Order Cancel Command

Message type: `order.cancel.requested.v1`

Required fields:

| Field | Rule |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `messageType` | Must be `order.cancel.requested.v1`. |
| `commandId` | Stable id for the cancel request. |
| `orderId` | Internal order id originally created by the backend. |
| `userId` | Backend-derived authenticated user id. Never accept frontend-supplied authority. |
| `symbol` | Uppercase Binance symbol, for example `BTCUSDT`. |
| `createdAt` | ISO-compatible timestamp. |
| `metadata` | JSON string in Redis, parsed as an object by consumers. |

Optional fields:

| Field | Rule |
| --- | --- |
| `requestId` | Request correlation id when available. |
| `source` | Defaults to `backend`. |

The execution service cancels by Binance `orderId` when a persisted `binanceOrderId` is available, otherwise by `origClientOrderId` using the internal `orderId`.

## Order Cancel-All Command

Message type: `order.cancel_all.requested.v1`

Required fields:

| Field | Rule |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `messageType` | Must be `order.cancel_all.requested.v1`. |
| `commandId` | Stable id for the cancel-all request. |
| `userId` | Backend-derived authenticated user id. |
| `symbol` | Uppercase Binance symbol. |
| `createdAt` | ISO-compatible timestamp. |
| `metadata` | JSON string in Redis, parsed as an object by consumers. |

Optional fields:

| Field | Rule |
| --- | --- |
| `requestId` | Request correlation id when available. |
| `source` | Defaults to `backend`. |

Cancel-all intentionally has no single `orderId`; lifecycle state is persisted against each matching local open order and against each canceled Binance result that maps back to a local `OrderCommand`.

## Backend Lifecycle API

Authenticated endpoints:

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/orders` | Persist submit intent, append `order.submit.requested.v1`, return `PENDING`. |
| `GET` | `/orders/:orderId` | Return one authenticated user's order plus event history. |
| `GET` | `/orders/open?symbol=BTCUSDT` | Return local open lifecycle rows, optionally scoped by symbol. |
| `DELETE` | `/orders/:orderId` | Persist cancel requested state and append `order.cancel.requested.v1`. |
| `DELETE` | `/orders/open?symbol=BTCUSDT` | Persist cancel requested state for matching local open orders and append `order.cancel_all.requested.v1`. |

All endpoints derive `userId` from the verified access token and reject `userId` / `user_id` in params, query strings, bodies, and nested request metadata.

## Producer Rules

- The backend remains the only public command gateway.
- The backend must persist `OrderCommand` before appending submit commands to the stream.
- Cancel and cancel-all endpoints must persist lifecycle state in `OrderCommand` / `OrderEvent` before appending stream commands.
- The backend must derive `userId` from the verified access token.
- The backend must build commands with the shared stream contract builders.
- The backend must read `ORDER_COMMAND_STREAM` through `getOrderStreamConfig`.
- Duplicate submits must be same-user and same-intent before they are treated as idempotent; a mismatched duplicate `orderId` must not append another stream entry.
- Until the execution service consumes streams, the backend also publishes the legacy `COMMANDS_CHANNEL` message after a successful stream append.
- Cancel and cancel-all commands must not be published to the legacy Pub/Sub command channel.
- Stream entries must not contain API keys, signatures, JWTs, refresh tokens, or decrypted credential payloads.
- Decimal trading values must stay as strings from request validation through stream append.

## Consumer Rules

- The execution service should read from `tradeco:orders:commands:v1` using consumer group `tradeco:execution:orders:v1`.
- Consumer names should be generated with `createOrderCommandConsumerName`.
- Each message must be parsed with `parseOrderCommandStreamEntry` before execution.
- Idempotency must use `commandId` and `orderId` before placing a Binance order.
- Cancel processing must call Binance Spot Testnet `DELETE /api/v3/order`.
- Cancel-all processing must call Binance Spot Testnet `DELETE /api/v3/openOrders`.
- Failed messages should be retried until `ORDER_COMMAND_MAX_ATTEMPTS`, then written to `tradeco:orders:commands:dlq:v1`.
- A message should be acknowledged only after durable status persistence and safe event publication are complete.
- Do not enable legacy Pub/Sub order consumption while stream consumption is healthy; backend dual-write would otherwise risk duplicate processing races.

## Dead Letter Fields

Dead-letter entries use message type `order.command.dead_lettered.v1`.

Required fields:

| Field | Rule |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `messageType` | Must be `order.command.dead_lettered.v1`. |
| `originalStreamId` | Redis stream id of the failed command. |
| `commandId` | Original command id when parseable. |
| `orderId` | Original order id when parseable. |
| `userId` | Original backend-authenticated user id when parseable. |
| `reason` | Sanitized failure reason. |
| `attempts` | Number of processing attempts. |
| `failedAt` | ISO-compatible timestamp. |
| `payload` | Sanitized JSON payload of the failed command. |

## Verification

Run the contract test suite:

```sh
npm run test:stream-contracts
```

Run the auth-boundary smoke check after stream contract changes because order command ownership and user scoping are security-sensitive:

```sh
npm run smoke:p0-auth-boundary
```
