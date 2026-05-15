# Redis Stream Contracts

Status: Contract committed. Backend producer dual-write is implemented; execution stream consumption is pending.

Tracker row: https://www.notion.so/3608ea2b3f8a81c78c7ecd629dd7d34f

## Scope

This document defines the Redis Streams naming and message envelope for asynchronous order processing. The backend now imports `@tradeco/redis-stream-contracts` and appends authenticated order submits to the command stream while temporarily dual-writing the legacy Pub/Sub channel for the current execution service.

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

## Producer Rules

- The backend remains the only public command gateway.
- The backend must persist `OrderCommand` before appending to the stream.
- The backend must derive `userId` from the verified access token.
- The backend must build commands with `buildOrderSubmitStreamEntry`.
- The backend must read `ORDER_COMMAND_STREAM` through `getOrderStreamConfig`.
- Duplicate submits must be same-user and same-intent before they are treated as idempotent; a mismatched duplicate `orderId` must not append another stream entry.
- Until the execution service consumes streams, the backend also publishes the legacy `COMMANDS_CHANNEL` message after a successful stream append.
- Stream entries must not contain API keys, signatures, JWTs, refresh tokens, or decrypted credential payloads.
- Decimal trading values must stay as strings from request validation through stream append.

## Consumer Rules

- The execution service should read from `tradeco:orders:commands:v1` using consumer group `tradeco:execution:orders:v1`.
- Consumer names should be generated with `createOrderCommandConsumerName`.
- Each message must be parsed with `parseOrderSubmitStreamEntry` before execution.
- Idempotency must use `commandId` and `orderId` before placing a Binance order.
- Failed messages should be retried until `ORDER_COMMAND_MAX_ATTEMPTS`, then written to `tradeco:orders:commands:dlq:v1`.
- A message should be acknowledged only after durable status persistence and safe event publication are complete.

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
