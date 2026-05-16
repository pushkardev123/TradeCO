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
const frontendLogout = read("apps/frontend/app/logout/page.js");
const backendIndex = read("apps/backend/src/index.js");
const backendMiddleware = read("apps/backend/src/middleware.js");
const eventService = read("apps/event-service/src/index.js");
const eventAuth = read("apps/event-service/src/auth.js");
const executionService = read("apps/execution-service/src/index.js");
const executionConfig = read("apps/execution-service/src/config.js");
const readme = read("README.md");

assert.match(frontendTrade, /ACCOUNT_BALANCES_CHANNEL = DEFAULT_REALTIME_CHANNELS\.balances|ACCOUNT_BALANCES_CHANNEL = "events:account:balances"/);
assert.match(frontendTrade, /DEFAULT_REALTIME_CHANNELS/);
assert.doesNotMatch(frontendTrade, /events:account:update/);
assert.match(frontendTrade, /\/account-info/);
assert.doesNotMatch(frontendTrade, /userId\s*:/);
assert.doesNotMatch(frontendAuth, /localStorage\.(?:getItem|setItem)\(\s*["']userId["']/);
assert.doesNotMatch(frontendAuth, /localStorage\.(?:getItem|setItem)\(\s*["']token["']/);
assert.match(frontendAuth, /let accessToken = null/);
assert.doesNotMatch(frontendLogout, /localStorage\.clear|sessionStorage\.clear/);

assert.match(backendMiddleware, /verifyAccessToken\(token\)/);
assert.match(backendMiddleware, /req\.user = \{ id: decoded\.sub, email: decoded\.email \|\| null, sessionId: decoded\.sid \}/);
assert.doesNotMatch(backendMiddleware, /decoded\?\.userId|decoded\?\.id/);
assert.match(backendIndex, /function rejectClientUserId/);
assert.match(backendIndex, /res\.status\(403\)\.json\(\{\s+ok: false,\s+error: "userId does not match the authenticated user"/);
assert.doesNotMatch(backendIndex, /userId:\s*["']test-user["']/);

assert.match(eventService, /function rejectUserIdParam/);
assert.match(eventService, /if \(hasUserIdParam\(u\)\)/);
assert.match(eventService, /if \(!token\) \{\s+socket\.write\("HTTP\/1\.1 401 Unauthorized\\r\\n\\r\\n"\)/);
assert.match(eventService, /verifyAccessToken\(token, JWT_SECRET\)/);
assert.match(eventService, /HTTP\/1\.1 403 Forbidden/);
assert.match(eventService, /return sendJson\(res, 410, \{ ok: false, error: "Submit orders through the backend API" \}\)/);
assert.match(eventAuth, /if \(!decoded\?\.sub \|\| !decoded\?\.sid\)/);
assert.doesNotMatch(eventAuth, /decoded\?\.userId|decoded\?\.id/);

assert.match(executionService, /BALANCES_CHANNEL = config\.balancesChannel/);
assert.match(executionConfig, /balancesChannel: readEnv\("BALANCES_CHANNEL", "events:account:balances"\)/);
assert.match(executionService, /type: "ACCOUNT_BALANCES"/);
assert.match(readme, /The canonical account balance Redis\/WebSocket channel is `events:account:balances`/);
assert.match(readme, /"type": "ACCOUNT_BALANCES"/);

console.log("p0-auth-boundary smoke checks passed");
