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

test("builds MARKET quoteOrderQty draft without base quantity", () => {
    const draft = createOrderSubmitDraftFromRequest({
        userId: "auth_user_123",
        orderId: "order_quote_123",
        body: {
            symbol: "BTCUSDT",
            side: "BUY",
            orderType: "MARKET",
            quoteOrderQty: "25.50",
        },
    });

    assert.equal(draft.quantity, undefined);
    assert.equal(draft.quoteOrderQty, "25.50");
    assert.equal(draft.streamEntry.quantity, undefined);
    assert.equal(draft.streamEntry.quoteOrderQty, "25.50");
});

test("rejects quoteOrderQty outside MARKET orders", () => {
    assert.throws(
        () => createOrderSubmitDraftFromRequest({
            userId: "auth_user_123",
            orderId: "order_quote_bad",
            body: {
                symbol: "BTCUSDT",
                side: "BUY",
                orderType: "LIMIT",
                quantity: "0.001",
                quoteOrderQty: "25",
                price: "65000.25",
            },
        }),
        /quoteOrderQty is only supported for MARKET orders/,
    );
});

test("builds advanced stop-limit and maker order drafts", () => {
    const stopLimit = createOrderSubmitDraftFromRequest({
        userId: "auth_user_123",
        orderId: "order_stop_limit",
        body: {
            symbol: "BTCUSDT",
            side: "SELL",
            orderType: "STOP_LOSS_LIMIT",
            quantity: "0.001",
            price: "64000",
            stopPrice: "64500",
        },
    });

    assert.equal(stopLimit.streamEntry.orderType, "STOP_LOSS_LIMIT");
    assert.equal(stopLimit.streamEntry.timeInForce, "GTC");
    assert.equal(stopLimit.streamEntry.price, "64000");
    assert.equal(stopLimit.streamEntry.stopPrice, "64500");

    const maker = createOrderSubmitDraftFromRequest({
        userId: "auth_user_123",
        orderId: "order_maker",
        body: {
            symbol: "BTCUSDT",
            side: "BUY",
            orderType: "LIMIT_MAKER",
            quantity: "0.001",
            price: "64000",
        },
    });

    assert.equal(maker.streamEntry.orderType, "LIMIT_MAKER");
    assert.equal(maker.streamEntry.timeInForce, undefined);
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
