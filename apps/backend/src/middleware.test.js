import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-jwt-secret-for-auth-middleware";
process.env.ENCRYPTION_KEY = "12345678901234567890123456789012";
process.env.JWT_ACCESS_TTL_SECONDS = "900";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/tradeco_test";
process.env.REDIS_URL = "redis://localhost:6379";

const { signAccessToken } = await import("./jwt.js");
const { requireAuth } = await import("./middleware.js");

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

test("requireAuth accepts access tokens with sub and sid", () => {
    const token = signAccessToken({
        user: { id: "user_1", email: "alice@example.com" },
        sessionId: "session_1",
    });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    let nextCalled = false;

    requireAuth(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.user.id, "user_1");
    assert.equal(req.user.sessionId, "session_1");
});

test("requireAuth rejects missing, expired, and legacy userId-only tokens", () => {
    const missingReq = { headers: {} };
    const missingRes = makeRes();
    requireAuth(missingReq, missingRes, () => assert.fail("next should not be called"));
    assert.equal(missingRes.statusCode, 401);

    const expired = jwt.sign(
        { sub: "user_1", sid: "session_1", email: "alice@example.com" },
        process.env.JWT_SECRET,
        { expiresIn: -1 }
    );
    const expiredReq = { headers: { authorization: `Bearer ${expired}` } };
    const expiredRes = makeRes();
    requireAuth(expiredReq, expiredRes, () => assert.fail("next should not be called"));
    assert.equal(expiredRes.statusCode, 401);

    const legacy = jwt.sign(
        { userId: "user_1", email: "alice@example.com" },
        process.env.JWT_SECRET,
        { expiresIn: "15m" }
    );
    const legacyReq = { headers: { authorization: `Bearer ${legacy}` } };
    const legacyRes = makeRes();
    requireAuth(legacyReq, legacyRes, () => assert.fail("next should not be called"));
    assert.equal(legacyRes.statusCode, 401);
});
