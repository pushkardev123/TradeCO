import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

import {
    canReceiveBroadcast,
    getMessageUserId,
    hasUserIdParam,
    shouldBroadcastChannelMessage,
    verifyAccessToken,
} from "./auth.js";

const JWT_SECRET = "test-jwt-secret-for-event-service";
const SCOPED_CHANNELS = ["events:order:status", "events:account:balances", "events:account:response"];

function sign(payload, options = {}) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "15m", ...options });
}

test("verifyAccessToken requires sub and sid access-token claims", () => {
    const token = sign({ sub: "user_1", sid: "session_1", email: "alice@example.com" });

    const user = verifyAccessToken(token, JWT_SECRET);

    assert.deepEqual(user, {
        id: "user_1",
        sessionId: "session_1",
        email: "alice@example.com",
    });
});

test("verifyAccessToken rejects legacy userId/id-only and expired tokens", () => {
    const legacyUserId = sign({ userId: "user_1", email: "alice@example.com" });
    const legacyId = sign({ id: "user_1", email: "alice@example.com" });
    const missingSession = sign({ sub: "user_1", email: "alice@example.com" });
    const expired = sign({ sub: "user_1", sid: "session_1" }, { expiresIn: -1 });

    assert.throws(() => verifyAccessToken(legacyUserId, JWT_SECRET), /Token missing required claims/);
    assert.throws(() => verifyAccessToken(legacyId, JWT_SECRET), /Token missing required claims/);
    assert.throws(() => verifyAccessToken(missingSession, JWT_SECRET), /Token missing required claims/);
    assert.throws(() => verifyAccessToken(expired, JWT_SECRET), /jwt expired/);
});

test("userId query params are detected before websocket acceptance", () => {
    assert.equal(hasUserIdParam(new URL("http://localhost:8081/prices?userId=user_1")), true);
    assert.equal(hasUserIdParam(new URL("http://localhost:8081/prices?user_id=user_1")), true);
    assert.equal(hasUserIdParam(new URL("http://localhost:8081/prices?token=abc")), false);
});

test("scoped messages require userId and only deliver to matching users", () => {
    const userOneWs = { user: { id: "user_1" } };
    const userTwoWs = { user: { id: "user_2" } };
    const scopedMessage = JSON.stringify({ userId: "user_1", orderId: "order_1", status: "FILLED" });
    const missingScope = JSON.stringify({ orderId: "order_1", status: "FILLED" });

    assert.equal(getMessageUserId(scopedMessage), "user_1");
    assert.equal(shouldBroadcastChannelMessage({
        channel: "events:order:status",
        message: missingScope,
        scopedChannels: SCOPED_CHANNELS,
    }), false);
    assert.equal(shouldBroadcastChannelMessage({
        channel: "events:order:status",
        message: scopedMessage,
        scopedChannels: SCOPED_CHANNELS,
    }), true);
    assert.equal(canReceiveBroadcast({
        ws: userOneWs,
        channel: "events:order:status",
        message: scopedMessage,
        scopedChannels: SCOPED_CHANNELS,
    }), true);
    assert.equal(canReceiveBroadcast({
        ws: userTwoWs,
        channel: "events:order:status",
        message: scopedMessage,
        scopedChannels: SCOPED_CHANNELS,
    }), false);
});

test("public market messages can broadcast without scoped user ids", () => {
    assert.equal(shouldBroadcastChannelMessage({
        channel: "events:price:update",
        message: JSON.stringify({ type: "PRICE_UPDATE", symbol: "BTCUSDT" }),
        scopedChannels: SCOPED_CHANNELS,
    }), true);
    assert.equal(canReceiveBroadcast({
        ws: { user: { id: "user_1" } },
        channel: "events:price:update",
        message: JSON.stringify({ type: "PRICE_UPDATE", symbol: "BTCUSDT" }),
        scopedChannels: SCOPED_CHANNELS,
    }), true);
});
