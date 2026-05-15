import assert from "node:assert/strict";
import test from "node:test";

import {
    REALTIME_CHANNELS,
    REALTIME_EVENT_TYPES,
    getRealtimeChannelConfig,
} from "@tradeco/redis-stream-contracts";
import {
    createRedisWebSocketEnvelope,
    validateBroadcastMessage,
} from "./broadcastContracts.js";

test("accepts valid scoped account balance broadcast payloads", () => {
    const message = JSON.stringify({
        type: REALTIME_EVENT_TYPES.accountBalances,
        userId: "user_123",
        ts: 1778880000000,
        balances: [{ asset: "USDT", free: "1000", locked: "0" }],
    });

    const result = validateBroadcastMessage({ channel: REALTIME_CHANNELS.balances, message });

    assert.equal(result.ok, true);
    assert.equal(result.payload.userId, "user_123");
});

test("rejects scoped broadcasts missing userId", () => {
    const message = JSON.stringify({
        type: REALTIME_EVENT_TYPES.accountBalances,
        ts: 1778880000000,
        balances: [{ asset: "USDT", free: "1000", locked: "0" }],
    });

    const result = validateBroadcastMessage({ channel: REALTIME_CHANNELS.balances, message });

    assert.equal(result.ok, false);
    assert.match(result.errors.join("; "), /userId/);
});

test("creates WebSocket REDIS_EVENT envelopes with nested payload validation", () => {
    const message = JSON.stringify({
        type: REALTIME_EVENT_TYPES.priceUpdate,
        symbol: "BTCUSDT",
        price: 65000,
        ts: 1778880000000,
    });

    const envelope = JSON.parse(createRedisWebSocketEnvelope({
        channel: REALTIME_CHANNELS.prices,
        message,
        ts: 1778880000001,
    }));

    assert.equal(envelope.type, "REDIS_EVENT");
    assert.equal(envelope.channel, REALTIME_CHANNELS.prices);
});

test("supports runtime channel overrides consistently", () => {
    const channels = getRealtimeChannelConfig({
        BALANCES_CHANNEL: "events:account:balances:test",
    });
    const message = JSON.stringify({
        type: REALTIME_EVENT_TYPES.accountBalances,
        userId: "user_123",
        ts: 1778880000000,
        balances: [{ asset: "USDT", free: "1000", locked: "0" }],
    });

    assert.equal(validateBroadcastMessage({ channel: channels.balances, message, channels }).ok, true);
    assert.throws(
        () => createRedisWebSocketEnvelope({ channel: REALTIME_CHANNELS.balances, message, channels }),
        /known realtime channel/,
    );
});
