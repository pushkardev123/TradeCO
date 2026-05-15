# Order Command Processing and Redis Streams

Status: Backend Redis Stream producer dual-write is implemented. Execution service stream consumption is still pending, so Pub/Sub remains temporarily required.

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
- If stream append fails after the database create, backend marks the command `STREAM_APPEND_FAILED` when possible and returns `503`. Do not expect the legacy Pub/Sub publish in that failure path.
- Duplicate submissions with the same authenticated user, `orderId`, and order intent return the existing command response without appending another stream entry. A duplicate for a command in `STREAM_APPEND_FAILED` retries the stream append.
- Execution service currently subscribes to the legacy Pub/Sub channel and submits orders to Binance Spot Testnet.
- Event service rejects public `POST /orders` ingress with `410` and tells callers to use the backend API.
- Redis Streams consumer group handling is not implemented in the execution service yet.
- The committed stream contract lives in `packages/redis-stream-contracts` and is documented in [Redis Stream Contracts](../architecture/redis-stream-contracts.md).

## Current Dual-Write Triage Procedure

1. Confirm backend accepted the command.
   Verify the request used a valid Bearer token and did not rely on frontend-supplied `userId`.

2. Confirm `OrderCommand` exists.
   Check the backend database for the internal `orderId`, authenticated `userId`, symbol, side, type, quantity, and status. Do not expose credentials while querying.

3. Confirm backend appended the command stream entry.
   Inspect `ORDER_COMMAND_STREAM`, defaulting to `tradeco:orders:commands:v1`, for an entry with the `orderId` and authenticated `userId`. Backend stream append failures should leave the persisted command in `STREAM_APPEND_FAILED` when the status update succeeds.

4. Confirm backend published the temporary legacy command.
   Review backend logs for `/orders` errors. The Pub/Sub publish happens only after the database create and stream append succeed.

5. Confirm execution service is subscribed.
   Execution service logs should show subscription to `COMMANDS_CHANNEL`.

6. Confirm credential decrypt succeeded.
   If the command is rejected because credentials cannot load or decrypt, follow [Credential Safety and Testnet Key Rotation](credential-safety-and-key-rotation.md) only when key material is invalid or exposed.

7. Confirm user-scoped event publication.
   Execution service publishes order status to `EVENTS_CHANNEL`, defaulting to `events:order:status`. Event service forwards scoped order updates only when the message contains a `userId` matching the authenticated WebSocket client.

## Verification Checks

- Backend order request derives user identity from the verified access token.
- Redis Stream entries use `order.submit.requested.v1`, `schemaVersion: 1`, and decimal strings for quantity, price, and stop price.
- Event service does not accept public order placement commands.
- Order command and latest order event share the expected `orderId` and `userId`.
- Logs do not contain API keys, signed URLs, JWTs, refresh tokens, or decrypted credential values.

## Risks

- The command stream is durable, but execution still depends on Pub/Sub until the stream consumer task lands.
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

The v1 order submit message type is `order.submit.requested.v1`. The backend must derive `userId` from the verified access token, persist `OrderCommand`, and then append a sanitized stream entry. Trading numeric values must be positive decimal strings, not JavaScript numbers.

Idempotency keys:

- `commandId`: stable stream-processing idempotency key.
- `orderId`: backend-created order id persisted before stream append.

Dead-letter message type: `order.command.dead_lettered.v1`.

## Pending Redis Streams Runtime Procedure

Complete this section after the execution service consumes Redis Streams in code.

- How execution service claims, acknowledges, retries, and dead-letters commands.
- How to inspect pending messages with Redis stream commands.
- How to safely replay or dead-letter a stuck command without duplicating a Binance order.
- Idempotency checks before retrying a command.

Do not use Redis stream consumer-group recovery commands in incidents until the execution runtime migration is merged and verified.
