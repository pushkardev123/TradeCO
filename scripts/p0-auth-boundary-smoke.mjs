import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function read(path) {
    return readFileSync(join(root, path), "utf8");
}

const frontendTrade = read("apps/frontend/app/trade/page.js");
const frontendAuth = read("apps/frontend/app/lib/auth.js");
const backendIndex = read("apps/backend/src/index.js");
const backendMiddleware = read("apps/backend/src/middleware.js");
const eventService = read("apps/event-service/src/index.js");
const executionService = read("apps/execution-service/src/index.js");
const readme = read("README.md");

assert.match(frontendTrade, /ACCOUNT_BALANCES_CHANNEL = "events:account:balances"/);
assert.doesNotMatch(frontendTrade, /events:account:update/);
assert.match(frontendTrade, /\/account-info/);
assert.doesNotMatch(frontendTrade, /userId\s*:/);
assert.doesNotMatch(frontendAuth, /localStorage\.(?:getItem|setItem)\(\s*["']userId["']/);

assert.match(backendMiddleware, /const userId = decoded\?\.userId \|\| decoded\?\.id \|\| decoded\?\.sub/);
assert.match(backendIndex, /function rejectClientUserId/);
assert.match(backendIndex, /res\.status\(403\)\.json\(\{\s+ok: false,\s+error: "userId does not match the authenticated user"/);
assert.doesNotMatch(backendIndex, /userId:\s*["']test-user["']/);

assert.match(eventService, /function rejectUserIdParam/);
assert.match(eventService, /if \(hasUserIdParam\(u\)\)/);
assert.match(eventService, /HTTP\/1\.1 403 Forbidden/);
assert.match(eventService, /return sendJson\(res, 410, \{ ok: false, error: "Submit orders through the backend API" \}\)/);

assert.match(executionService, /BALANCES_CHANNEL = process\.env\.BALANCES_CHANNEL \|\| "events:account:balances"/);
assert.match(executionService, /type: "ACCOUNT_BALANCES"/);
assert.match(readme, /The canonical account balance Redis\/WebSocket channel is `events:account:balances`/);
assert.match(readme, /"type": "ACCOUNT_BALANCES"/);

console.log("p0-auth-boundary smoke checks passed");
