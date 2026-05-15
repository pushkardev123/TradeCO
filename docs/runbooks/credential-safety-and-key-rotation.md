# Credential Safety and Testnet Key Rotation

Status: Complete for the current implementation.

Tracker row: https://www.notion.so/3608ea2b3f8a8128aedbff6ac60569a4

## Owner

Primary owner: Backend/API owner.

Backup owner: Execution service owner.

Manager responsibility: confirm incident severity, approve any manual credential replacement, and verify tracker notes are updated after rotation.

## Scope

This runbook covers Binance Spot Testnet API keys collected during TradeCO signup and used by the backend and execution service. The keys are testnet-only, but they must be handled as secrets because they can place testnet orders and reveal account state.

Current implementation facts:

- Signup collects `binanceApiKey` and `binanceSecretKey` in `apps/frontend/app/register/page.js`.
- Backend registration encrypts both values in `apps/backend/src/index.js`.
- Encryption uses AES-256-GCM in `apps/backend/src/crypto.js`.
- `ENCRYPTION_KEY` must be exactly 32 characters and must be available to backend and execution service processes that encrypt or decrypt credentials.
- Current Prisma schema stores encrypted keys on `User` as `binanceApiKeyEnc` and `binanceSecretKeyEnc`.
- The target architecture says credentials should move to a separate `ExchangeCredential` model. That migration is not present yet.

Official testnet entry points to use when rotating keys:

- Binance Spot Testnet portal: https://testnet.binance.vision/
- Binance Spot API Testnet documentation: https://developers.binance.com/docs/binance-spot-api-docs/testnet

## Non-Goals

- Do not add production trading endpoints.
- Do not document or commit real credentials.
- Do not call Binance as part of documentation-only verification.
- Do not rotate `ENCRYPTION_KEY` in the same incident unless encrypted credential re-encryption is explicitly planned and tested.

## Credential Handling Rules

- Treat Binance Testnet API keys as secrets even though they are testnet credentials.
- Never commit API keys, secret keys, JWTs, refresh tokens, signatures, `.env` files, encrypted credential payloads, screenshots containing keys, or generated credential material.
- Never paste keys into Notion, GitHub issues, PR descriptions, chat, logs, terminal transcripts, screenshots, or docs.
- Do not log decrypted credential values or signed Binance URLs.
- Do not store credentials in shell history. Prefer a password manager or another approved secret store.
- Redact with a fixed marker such as `[REDACTED_TESTNET_API_KEY]`; do not keep first or last characters in shared docs.
- Use separate credentials for each user or test account. Do not share one Binance Testnet key across developers.
- If a key appears outside approved secret storage, assume it is exposed and rotate it.

## Rotation Triggers

Rotate the affected Binance Spot Testnet key pair when any of these happen:

- A key or secret is committed, pasted into Notion, pasted into chat, uploaded in a screenshot, or printed in logs.
- A developer loses control of the machine or account where keys were stored.
- A test account changes owner.
- An environment using the key is decommissioned.
- Binance Testnet resets or invalidates credentials.
- A manager or service owner cannot prove where a key has been stored.

## Key Rotation Procedure

1. Stop propagation.
   Remove the credential from the visible surface immediately. Do not repost the value while asking for help. If it is in git, preserve evidence for remediation but do not copy the secret into new commits or comments.

2. Record non-secret incident metadata.
   Capture who found it, where it was exposed, when it was found, which environment or test account was affected, and which services may have used the key. Do not record the key value.

3. Revoke the exposed key in Binance Spot Testnet.
   Use the Binance Spot Testnet portal. Delete or disable the affected API key pair. Do this before creating replacement credentials when exposure is suspected.

4. Create a replacement Binance Spot Testnet key pair.
   Create a new testnet-only API key pair for the same test account. Store it only in approved secret storage.

5. Replace the credential in TradeCO.
   Current app limitation: there is no self-service credential rotation endpoint and no separate `ExchangeCredential` model yet. Use one of these approved paths:

   - Preferred current path for non-incident development accounts: create a new TradeCO account with the replacement testnet keys, then retire the old account.
   - Incident path when preserving the same TradeCO user is required: have the backend owner perform a reviewed one-off admin update that encrypts the replacement key pair with the deployed `ENCRYPTION_KEY` and updates only that user's encrypted credential fields. Keep the one-off script out of git unless it is sanitized, reviewed, and contains no credential literals.

6. Clear process-local state.
   Restart the execution service if the affected user had active account or user-data streams, because the current implementation keeps in-memory user stream state. Restart backend only if its environment changed.

7. Verify with non-secret checks.
   Confirm the app can authenticate the affected user or replacement account. Confirm no logs contain keys, signatures, signed URLs, JWTs, refresh tokens, or encrypted credential payloads. Live account or order verification requires an operator with valid testnet credentials and is not part of documentation-only QA.

8. Update the tracker.
   Record the rotation date, affected environment or test account, services restarted, verification performed, and any pending follow-up. Leave PR Link blank until a PR exists.

## Emergency Git Exposure Checklist

Use this checklist if credentials were committed:

- Revoke the exposed Binance Spot Testnet key pair first.
- Remove the secret from the current working tree.
- Do not rely on a revert as rotation.
- If the repository was pushed, assume the secret is permanently exposed.
- Coordinate history cleanup only after revocation. History cleanup reduces accidental rediscovery, but it does not make an exposed key safe again.
- Verify `rg -n "apiKey|secretKey|X-MBX-APIKEY|signature|JWT|refresh token|ENCRYPTION_KEY" docs README.md apps` does not show real secrets before committing docs.

## Verification Checks

Documentation-only QA:

- `rg -n "apiKey|secretKey|X-MBX-APIKEY|signature|JWT|refresh token|ENCRYPTION_KEY" docs README.md apps` reviewed for real secrets.
- Runbook explicitly says keys are testnet-only but still secrets.
- Runbook includes revocation, replacement, TradeCO update path, service restart guidance, verification, and tracker update steps.
- Runbook does not include real credentials or signed URLs.

Operational QA when rotating a real testnet key:

- Old key is revoked in Binance Spot Testnet.
- Replacement key is stored only in approved secret storage.
- TradeCO account is replaced or updated through an approved admin path.
- Execution service process-local streams were cleared when needed.
- Logs were reviewed for leaked credential material.

## Risks

- Current credential storage is on `User`; the future `ExchangeCredential` model will change the exact update path.
- Manual DB updates can corrupt encrypted payloads if the wrong `ENCRYPTION_KEY` is used.
- Restarting execution service can interrupt active market and user streams.
- Signed Binance URLs include signatures and must be treated as secret material.

## Pending Implementation-Dependent Work

- Add a separate `ExchangeCredential` model and update this runbook with model-specific rotation steps.
- Add a reviewed credential update or rotation endpoint/script so operators do not need an ad hoc admin update.
- Add refresh-token rotation docs once the access/refresh implementation exists.
- Move frontend web access tokens away from `localStorage`; this is tracked separately as an auth safety risk.
