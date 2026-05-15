import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = "test-jwt-secret-for-order-stream-producer";
process.env.ENCRYPTION_KEY = "12345678901234567890123456789012";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/tradeco_test";
process.env.REDIS_URL = "redis://localhost:6379";

const {
    appendOrderCommandStreamEntry,
    appendOrderSubmitStreamEntry,
    createOrderCancelAllDraftFromRequest,
    createOrderCancelDraftFromRequest,
    createOrderSubmitDraftFromRequest,
    getRequestIdFromHeaders,
    isSameOrderIntent,
    shouldRetryStreamAppend,
} = await import("./orderStreamProducer.js");

test("builds v1 order stream entry with authenticated ownership and string decimals", () => {
    const draft = createOrderSubmitDraftFromRequest({
        userId: "auth_user_123",
        orderId: "order_123",
        requestId: "req_123",
        createdAt: new Date("2026-05-16T00:00:00.000Z"),
        body: {
            userId: "attacker_user",
            symbol: "btcusdt",
            side: "buy",
            orderType: "limit",
            quantity: "0.001",
            price: "65000.25",
            meta: {
                apiKey: "should-not-enter-stream",
            },
        },
    });

    assert.equal(draft.userId, "auth_user_123");
    assert.equal(draft.streamEntry.schemaVersion, "1");
    assert.equal(draft.streamEntry.messageType, "order.submit.requested.v1");
    assert.equal(draft.streamEntry.commandId, "order_123");
    assert.equal(draft.streamEntry.orderId, "order_123");
    assert.equal(draft.streamEntry.userId, "auth_user_123");
    assert.equal(draft.streamEntry.symbol, "BTCUSDT");
    assert.equal(draft.streamEntry.side, "BUY");
    assert.equal(draft.streamEntry.orderType, "LIMIT");
    assert.equal(draft.streamEntry.quantity, "0.001");
    assert.equal(draft.streamEntry.price, "65000.25");
    assert.equal(draft.streamEntry.timeInForce, "GTC");
    assert.equal(draft.streamEntry.requestId, "req_123");
    assert.equal(draft.streamEntry.createdAt, "2026-05-16T00:00:00.000Z");
    assert.equal(draft.streamEntry.metadata, "{}");
    assert.doesNotMatch(JSON.stringify(draft.streamEntry), /attacker_user|should-not-enter-stream|apiKey/i);
});

test("rejects unsupported decimal notation before stream append", () => {
    assert.throws(
        () => createOrderSubmitDraftFromRequest({
            userId: "auth_user_123",
            orderId: "order_123",
            body: {
                symbol: "ETHUSDT",
                side: "SELL",
                orderType: "MARKET",
                quantity: "1e-7",
            },
        }),
        /quantity must be a positive decimal string/,
    );
});

test("appends stream entry with Redis XADD using configured stream name", async () => {
    const calls = [];
    const redis = {
        async xAdd(streamName, id, entry) {
            calls.push({ streamName, id, entry });
            return "1715712000000-0";
        },
    };

    const streamEntry = { schemaVersion: "1", quantity: "0.001" };
    const streamId = await appendOrderSubmitStreamEntry({
        redis,
        streamName: "orders:commands:test",
        streamEntry,
    });

    assert.equal(streamId, "1715712000000-0");
    assert.deepEqual(calls, [{
        streamName: "orders:commands:test",
        id: "*",
        entry: streamEntry,
    }]);
});

test("builds cancel command without trusting body userId", () => {
    const draft = createOrderCancelDraftFromRequest({
        userId: "auth_user_123",
        orderId: "order_123",
        symbol: "btcusdt",
        commandId: "cancel_123",
        requestId: "req_cancel",
        createdAt: new Date("2026-05-16T00:00:00.000Z"),
        body: {
            userId: "attacker_user",
            symbol: "ethusdt",
        },
    });

    assert.equal(draft.userId, "auth_user_123");
    assert.equal(draft.symbol, "BTCUSDT");
    assert.equal(draft.streamEntry.messageType, "order.cancel.requested.v1");
    assert.equal(draft.streamEntry.commandId, "cancel_123");
    assert.equal(draft.streamEntry.orderId, "order_123");
    assert.equal(draft.streamEntry.userId, "auth_user_123");
    assert.equal(draft.streamEntry.symbol, "BTCUSDT");
    assert.doesNotMatch(JSON.stringify(draft.streamEntry), /attacker_user/i);
});

test("builds cancel-all command for authenticated user and symbol", () => {
    const draft = createOrderCancelAllDraftFromRequest({
        userId: "auth_user_123",
        commandId: "cancel_all_123",
        requestId: "req_cancel_all",
        createdAt: new Date("2026-05-16T00:00:00.000Z"),
        query: {
            userId: "attacker_user",
            symbol: "ethusdt",
        },
    });

    assert.equal(draft.userId, "auth_user_123");
    assert.equal(draft.symbol, "ETHUSDT");
    assert.equal(draft.streamEntry.messageType, "order.cancel_all.requested.v1");
    assert.equal(draft.streamEntry.commandId, "cancel_all_123");
    assert.equal(draft.streamEntry.userId, "auth_user_123");
    assert.equal(draft.streamEntry.symbol, "ETHUSDT");
    assert.equal(draft.streamEntry.orderId, undefined);
    assert.doesNotMatch(JSON.stringify(draft.streamEntry), /attacker_user/i);
});

test("appends generic lifecycle stream entries", async () => {
    const calls = [];
    const redis = {
        async xAdd(streamName, id, entry) {
            calls.push({ streamName, id, entry });
            return "1715712000000-2";
        },
    };

    const streamEntry = { schemaVersion: "1", messageType: "order.cancel.requested.v1" };
    const streamId = await appendOrderCommandStreamEntry({
        redis,
        streamName: "orders:commands:test",
        streamEntry,
    });

    assert.equal(streamId, "1715712000000-2");
    assert.deepEqual(calls, [{
        streamName: "orders:commands:test",
        id: "*",
        entry: streamEntry,
    }]);
});

test("detects safe same-user duplicate submissions and stream retry state", () => {
    const draft = createOrderSubmitDraftFromRequest({
        userId: "auth_user_123",
        orderId: "order_123",
        body: {
            symbol: "BTCUSDT",
            side: "BUY",
            orderType: "MARKET",
            quantity: "0.001",
        },
    });

    assert.equal(isSameOrderIntent({
        userId: "auth_user_123",
        orderId: "order_123",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        quantity: 0.001,
        price: null,
        stopPrice: null,
        timeInForce: null,
        status: "RECEIVED",
    }, draft), true);

    assert.equal(isSameOrderIntent({
        userId: "other_user",
        orderId: "order_123",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        quantity: 0.001,
        price: null,
        stopPrice: null,
        timeInForce: null,
    }, draft), false);

    assert.equal(shouldRetryStreamAppend({ status: "STREAM_APPEND_FAILED" }), true);
    assert.equal(shouldRetryStreamAppend({ status: "RECEIVED" }), false);
});

test("reads x-request-id without trusting request bodies for identity", () => {
    assert.equal(getRequestIdFromHeaders({ "x-request-id": " req_abc " }), "req_abc");
    assert.equal(getRequestIdFromHeaders({ "x-request-id": ["req_first", "req_second"] }), "req_first");
});
