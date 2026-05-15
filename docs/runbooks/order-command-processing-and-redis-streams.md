# Order Command Processing and Redis Streams

Status: Redis Streams contract committed. Runtime migration is pending because current checked-in code still uses Redis Pub/Sub for command transport.

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

- Backend `POST /orders` persists `OrderCommand` and publishes JSON to the Redis Pub/Sub channel configured by `COMMANDS_CHANNEL`, defaulting to `commands:order:submit`.
- Execution service subscribes to that channel and submits orders to Binance Spot Testnet.
- Event service rejects public `POST /orders` ingress with `410` and tells callers to use the backend API.
- Redis Streams consumer group handling is not implemented in the checked-in code yet.
- The committed stream contract lives in `packages/redis-stream-contracts` and is documented in [Redis Stream Contracts](../architecture/redis-stream-contracts.md).

## Current Pub/Sub Triage Procedure

1. Confirm backend accepted the command.
   Verify the request used a valid Bearer token and did not rely on frontend-supplied `userId`.

2. Confirm `OrderCommand` exists.
   Check the backend database for the internal `orderId`, authenticated `userId`, symbol, side, type, quantity, and status. Do not expose credentials while querying.

3. Confirm backend published the command.
   Review backend logs for `/orders` errors. The current code publishes to `COMMANDS_CHANNEL` after the database create succeeds.

4. Confirm execution service is subscribed.
   Execution service logs should show subscription to `COMMANDS_CHANNEL`.

5. Confirm credential decrypt succeeded.
   If the command is rejected because credentials cannot load or decrypt, follow [Credential Safety and Testnet Key Rotation](credential-safety-and-key-rotation.md) only when key material is invalid or exposed.

6. Confirm user-scoped event publication.
   Execution service publishes order status to `EVENTS_CHANNEL`, defaulting to `events:order:status`. Event service forwards scoped order updates only when the message contains a `userId` matching the authenticated WebSocket client.

## Verification Checks

- Backend order request derives user identity from the verified access token.
- Event service does not accept public order placement commands.
- Order command and latest order event share the expected `orderId` and `userId`.
- Logs do not contain API keys, signed URLs, JWTs, refresh tokens, or decrypted credential values.

## Risks

- Pub/Sub is not durable. If execution service is offline when backend publishes, the command can be lost.
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

Complete this section only after backend and execution services actually use Redis Streams in code.

- How backend appends commands and records stream IDs.
- How execution service claims, acknowledges, retries, and dead-letters commands.
- How to inspect pending messages with Redis stream commands.
- How to safely replay or dead-letter a stuck command without duplicating a Binance order.
- Idempotency checks before retrying a command.

Do not use Redis stream recovery commands in incidents until the runtime migration is merged and verified.
