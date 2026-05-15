# Deployment Rollback

Status: Initial structure. Deployment-specific commands are pending because release tooling is not documented in this repo.

Tracker row: https://www.notion.so/3608ea2b3f8a81ff8e58dbde4c5b164a

## Owner

Primary owner: Release owner.

Backup owner: Service owner for the changed service.

## Scope

Use this runbook when a deployed TradeCO change must be rolled back in a testnet environment.

## Rollback Decision Criteria

Rollback should be considered when:

- Authentication or user scoping is broken.
- Credential encryption/decryption is broken.
- Event service exposes scoped user data to the wrong client.
- Backend accepts unsafe order input or trusts client-supplied `userId`.
- Execution service submits incorrect testnet orders.
- A release logs secrets, signed URLs, JWTs, refresh tokens, or decrypted credential values.
- A migration or deploy blocks local or testnet verification.

## General Rollback Procedure

1. Freeze risky activity.
   Stop live testnet verification and order submission tests until the release owner decides whether to roll back.

2. Identify the last known good revision.
   Use the deployment platform, git history, and tracker notes. Do not infer this from memory when production-like environments are affected.

3. Check for schema or data changes.
   If the release included Prisma schema changes or data migrations, decide whether rollback requires a forward fix instead of code rollback.

4. Roll back the affected service.
   Use the deployment platform's documented rollback process.

5. Restart dependent services only if needed.
   Backend, event service, and execution service can be restarted independently, but execution and event restarts interrupt streams and clients.

6. Verify health and safety checks.
   Run health checks and security-sensitive manual checks before resuming live testnet activity.

7. Update the tracker.
   Record the bad revision, rollback revision, affected service, verification result, and any follow-up fix.

## Verification Checks

- Backend `/health` returns ok.
- Event service `/health` returns ok.
- Authenticated requests still derive user identity from the verified access token.
- Event service does not accept public order placement commands.
- No logs contain secrets or signed URLs.
- If live testnet verification is approved, order/account behavior is checked with testnet-only credentials.

## Risks

- Rolling back code without considering schema changes can leave services incompatible with the database.
- Rolling back execution service can interrupt active market/user streams.
- A rollback does not rotate exposed credentials. Follow the credential rotation runbook if secrets leaked.

## Pending Implementation-Dependent Work

- Add exact Vercel rollback steps for frontend.
- Add exact VPS or PM2 rollback steps for backend, event service, and execution service.
- Add database migration rollback or forward-fix policy.
- Link rollback records to PRs once PRs are created for future work.
