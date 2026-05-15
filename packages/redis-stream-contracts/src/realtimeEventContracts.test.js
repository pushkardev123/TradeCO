import assert from "node:assert/strict";
import test from "node:test";

import {
    REALTIME_CHANNELS,
    REALTIME_EVENT_TYPES,
    SCOPED_REALTIME_CHANNELS,
    assertRealtimeChannelPayload,
    getRealtimeChannelConfig,
    validateRealtimeChannelPayload,
    validateWebSocketRedisEnvelope,
} from "./realtimeEventContracts.js";

test("defines canonical realtime channels including account balances", () => {
    assert.equal(REALTIME_CHANNELS.orders, "events:order:status");
    assert.equal(REALTIME_CHANNELS.prices, "events:price:update");
    assert.equal(REALTIME_CHANNELS.balances, "events:account:balances");
    assert.notEqual(REALTIME_CHANNELS.balances, "events:account:update");
    assert.deepEqual(SCOPED_REALTIME_CHANNELS, [
        "events:order:status",
        "events:account:balances",
        "events:account:response",
    ]);
});

test("validates scoped order status events with decimal string fields", () => {
    const payload = {
        orderId: "order_123",
        userId: "user_123",
        status: "FILLED",
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quantity: "0.001",
        price: "65000",
        binance: { orderId: 98765, clientOrderId: "order_123" },
        timestamp: "2026-05-16T00:00:00.000Z",
    };

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.orders, payload), []);
    assert.equal(assertRealtimeChannelPayload(REALTIME_CHANNELS.orders, payload), true);
});

test("validates account balance events only on the canonical balances channel", () => {
    const payload = {
        type: REALTIME_EVENT_TYPES.accountBalances,
        userId: "user_123",
        ts: 1778880000000,
        balances: [
            { asset: "BTC", free: "0.001", locked: "0" },
            { asset: "USDT", free: "935", locked: "65" },
        ],
    };

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.balances, payload), []);
    assert.match(
        validateRealtimeChannelPayload("events:account:update", payload).join("; "),
        /unsupported realtime channel/,
    );
});

test("rejects scoped events missing userId before websocket fanout", () => {
    const missingUserPayload = {
        type: REALTIME_EVENT_TYPES.accountBalances,
        ts: 1778880000000,
        balances: [{ asset: "USDT", free: "1000", locked: "0" }],
    };

    assert.match(
        validateRealtimeChannelPayload(REALTIME_CHANNELS.balances, missingUserPayload).join("; "),
        /userId must be a non-empty string/,
    );
});

test("validates market, chart, symbol, and account RPC payloads", () => {
    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.prices, {
        type: REALTIME_EVENT_TYPES.priceUpdate,
        symbol: "BTCUSDT",
        price: 65000.25,
        ts: 1778880000000,
    }), []);

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.prices, {
        type: REALTIME_EVENT_TYPES.marketBoard,
        ts: 1778880000000,
        data: [{ symbol: "BTCUSDT", price: 65000.25 }],
    }), []);

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.charts, {
        type: REALTIME_EVENT_TYPES.klineSnapshot,
        ts: 1778880000000,
        symbol: "BTCUSDT",
        interval: "1m",
        candles: [{ time: 1778880000, open: 1, high: 2, low: 1, close: 2 }],
        source: "REST",
    }), []);

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.charts, {
        type: REALTIME_EVENT_TYPES.klineUpdate,
        ts: 1778880000000,
        symbol: "BTCUSDT",
        interval: "1m",
        kline: { open: "1", high: "2", low: "1", close: "2", isFinal: false },
    }), []);

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.symbolRequest, {
        type: REALTIME_EVENT_TYPES.symbolInfoRequest,
        id: "symbol-1",
        symbol: "BTCUSDT",
        replyTo: REALTIME_CHANNELS.symbolResponse,
    }), []);

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.accountRequest, {
        type: REALTIME_EVENT_TYPES.accountInfoRequest,
        id: "account-1",
        userId: "user_123",
        pinnedAssets: ["BTC", "USDT"],
        replyTo: REALTIME_CHANNELS.accountResponse,
    }), []);

    assert.deepEqual(validateRealtimeChannelPayload(REALTIME_CHANNELS.accountResponse, {
        type: REALTIME_EVENT_TYPES.accountInfoResponse,
        id: "account-1",
        userId: "user_123",
        ok: true,
        data: { pinned: [], nonZero: [] },
    }), []);
});

test("validates websocket Redis envelopes and nested channel payloads", () => {
    const inner = {
        type: REALTIME_EVENT_TYPES.accountBalances,
        userId: "user_123",
        ts: 1778880000000,
        balances: [{ asset: "USDT", free: "1000", locked: "0" }],
    };

    assert.deepEqual(validateWebSocketRedisEnvelope({
        type: REALTIME_EVENT_TYPES.redisEnvelope,
        channel: REALTIME_CHANNELS.balances,
        message: JSON.stringify(inner),
        ts: 1778880000001,
    }), []);

    assert.match(
        validateWebSocketRedisEnvelope({
            type: REALTIME_EVENT_TYPES.redisEnvelope,
            channel: REALTIME_CHANNELS.balances,
            message: JSON.stringify({ ...inner, userId: "" }),
            ts: 1778880000001,
        }).join("; "),
        /message.userId/,
    );
});

test("reads realtime channel environment overrides", () => {
    const config = getRealtimeChannelConfig({
        BALANCES_CHANNEL: "events:account:balances:test",
        PRICES_CHANNEL: "events:price:update:test",
    });

    assert.equal(config.balances, "events:account:balances:test");
    assert.equal(config.prices, "events:price:update:test");
    assert.equal(config.orders, REALTIME_CHANNELS.orders);
});
