# Operations Runbooks

These runbooks document the operational procedures that are accurate for the current TradeCO testnet-only codebase. Implementation-dependent sections are intentionally marked `Pending` instead of guessing at future behavior.

## Tracker Scope

- Credential safety and key rotation: https://www.notion.so/3608ea2b3f8a8128aedbff6ac60569a4
- Operations and testnet reset runbooks: https://www.notion.so/3608ea2b3f8a81ff8e58dbde4c5b164a

No real credentials belong in this directory. Testnet keys, JWTs, refresh tokens, signatures, `.env` files, encrypted credential payloads, and generated credential material must stay out of git and out of docs.

## Runbook Index

| Runbook | Status | Owner | Purpose |
| --- | --- | --- | --- |
| [Credential Safety and Testnet Key Rotation](credential-safety-and-key-rotation.md) | Complete for current implementation | Backend/API owner | Rotate exposed Binance Spot Testnet keys and handle credential material safely. |
| [Binance Testnet Reset Handling](binance-testnet-reset.md) | Initial structure; partially complete | Execution service owner | Respond when Binance Spot Testnet resets data, invalidates keys, or changes expected testnet state. |
| [Local Setup Verification](local-setup-verification.md) | Initial structure; mostly complete | Service owner running the environment | Bring up local services and verify without leaking secrets. |
| [Service Recovery](service-recovery.md) | Initial structure; local recovery complete, production pending | Service owner on call | Recover frontend, backend, event service, and execution service. |
| [Order Command Processing and Redis Streams](order-command-processing-and-redis-streams.md) | Backend producer, execution consumer, local Redis smoke, and recovery commands documented | Backend and execution owners | Diagnose command processing and Redis Stream stuck-message handling. |
| [Deployment Rollback](deployment-rollback.md) | Initial structure; deployment-specific commands pending | Release owner | Roll back a bad deploy once deployment tooling is documented. |

## Runbook Standard

Each runbook should keep these sections current:

- Owner and backup owner.
- Scope and non-goals.
- Preconditions and required access.
- Step-by-step procedure.
- Risks and safety checks.
- Verification checks.
- Pending implementation-dependent work.

## Current Architecture Notes

- The app is Binance Spot Testnet only.
- The backend is the authenticated command gateway for order submission.
- The event service must not accept public order placement commands.
- Current checked-in order command transport uses Redis Streams for backend-to-execution order processing. Backend still dual-writes Pub/Sub temporarily, and execution Pub/Sub order processing is fallback-only.
- Current checked-in credential storage uses the separate `ExchangeCredential` model with encrypted fields.
