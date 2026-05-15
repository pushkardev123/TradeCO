import assert from "node:assert/strict";
import test from "node:test";

import {
    ORDER_COMMAND_TYPES,
    ORDER_EVENT_TYPES,
    ORDER_STREAMS,
    buildOrderCancelAllStreamEntry,
    buildOrderCancelStreamEntry,
    buildOrderCommandDeadLetterEntry,
    buildOrderSubmitStreamEntry,
    createOrderCommandConsumerName,
    getOrderStreamConfig,
    parseOrderCancelAllStreamEntry,
    parseOrderCancelStreamEntry,
    parseOrderCommandStreamEntry,
    parseOrderSubmitStreamEntry,
    validateOrderCancelAllCommand,
    validateOrderCancelCommand,
    validateOrderSubmitCommand,
} from "./index.js";

const baseCommand = Object.freeze({
    schemaVersion: "1",
    messageType: ORDER_COMMAND_TYPES.submit,
    commandId: "cmd_123",
    orderId: "order_123",
    userId: "user_123",
    symbol: "btcusdt",
    side: "buy",
    orderType: "market",
    quantity: "0.001",
    requestId: "req_123",
    createdAt: "2026-05-15T00:00:00.000Z",
    metadata: {
        client: "web",
    },
});

test("builds a valid MARKET order stream entry with decimal strings", () => {
    const entry = buildOrderSubmitStreamEntry(baseCommand);

    assert.equal(entry.schemaVersion, "1");
    assert.equal(entry.messageType, ORDER_COMMAND_TYPES.submit);
    assert.equal(entry.symbol, "BTCUSDT");
    assert.equal(entry.side, "BUY");
    assert.equal(entry.orderType, "MARKET");
    assert.equal(entry.quantity, "0.001");
    assert.equal(entry.source, "backend");
    assert.equal(entry.metadata, JSON.stringify({ client: "web" }));
    assert.equal(entry.price, undefined);
});

test("rejects JavaScript numbers for trading decimal fields", () => {
    const errors = validateOrderSubmitCommand({
        ...baseCommand,
        quantity: 0.001,
    });

    assert.match(errors.join("\n"), /quantity must be a positive decimal string/);
});

test("requires price and timeInForce for LIMIT order commands", () => {
    const errors = validateOrderSubmitCommand({
        ...baseCommand,
        orderType: "LIMIT",
    });

    assert.match(errors.join("\n"), /price must be a positive decimal string/);
    assert.match(errors.join("\n"), /timeInForce must be one of GTC, IOC, FOK/);

    assert.deepEqual(
        validateOrderSubmitCommand({
            ...baseCommand,
            orderType: "LIMIT",
            price: "65000.25",
            timeInForce: "GTC",
        }),
        [],
    );
});

test("requires price for LIMIT_MAKER order commands without requiring timeInForce", () => {
    const errors = validateOrderSubmitCommand({
        ...baseCommand,
        orderType: "LIMIT_MAKER",
    });

    assert.match(errors.join("\n"), /price must be a positive decimal string/);

    assert.deepEqual(
        validateOrderSubmitCommand({
            ...baseCommand,
            orderType: "LIMIT_MAKER",
            price: "65000.25",
        }),
        [],
    );
});

test("requires stopPrice for stop order commands", () => {
    const errors = validateOrderSubmitCommand({
        ...baseCommand,
        orderType: "STOP_LOSS",
    });

    assert.match(errors.join("\n"), /stopPrice must be a positive decimal string/);
});

test("parses a stream entry and preserves normalized decimal strings", () => {
    const entry = buildOrderSubmitStreamEntry({
        ...baseCommand,
        orderType: "LIMIT",
        price: "65000.25",
        timeInForce: "gtc",
    });
    const parsed = parseOrderSubmitStreamEntry(entry);

    assert.equal(parsed.symbol, "BTCUSDT");
    assert.equal(parsed.side, "BUY");
    assert.equal(parsed.orderType, "LIMIT");
    assert.equal(parsed.quantity, "0.001");
    assert.equal(parsed.price, "65000.25");
    assert.equal(parsed.timeInForce, "GTC");
    assert.deepEqual(parsed.metadata, { client: "web" });
});

test("builds and parses an order cancel stream entry", () => {
    const entry = buildOrderCancelStreamEntry({
        commandId: "cancel_123",
        orderId: "order_123",
        userId: "user_123",
        symbol: "btcusdt",
        requestId: "req_cancel",
        createdAt: "2026-05-16T00:00:00.000Z",
        metadata: { reason: "user_requested" },
    });

    assert.equal(entry.schemaVersion, "1");
    assert.equal(entry.messageType, ORDER_COMMAND_TYPES.cancel);
    assert.equal(entry.commandId, "cancel_123");
    assert.equal(entry.orderId, "order_123");
    assert.equal(entry.userId, "user_123");
    assert.equal(entry.symbol, "BTCUSDT");
    assert.equal(entry.metadata, JSON.stringify({ reason: "user_requested" }));

    assert.deepEqual(parseOrderCancelStreamEntry(entry), {
        schemaVersion: "1",
        messageType: ORDER_COMMAND_TYPES.cancel,
        commandId: "cancel_123",
        orderId: "order_123",
        userId: "user_123",
        symbol: "BTCUSDT",
        requestId: "req_cancel",
        source: "backend",
        createdAt: "2026-05-16T00:00:00.000Z",
        metadata: { reason: "user_requested" },
    });
    assert.equal(parseOrderCommandStreamEntry(entry).messageType, ORDER_COMMAND_TYPES.cancel);
});

test("builds and parses an order cancel-all stream entry", () => {
    const entry = buildOrderCancelAllStreamEntry({
        commandId: "cancel_all_123",
        userId: "user_123",
        symbol: "ethusdt",
        requestId: "req_cancel_all",
        createdAt: "2026-05-16T00:00:00.000Z",
    });

    assert.equal(entry.schemaVersion, "1");
    assert.equal(entry.messageType, ORDER_COMMAND_TYPES.cancelAll);
    assert.equal(entry.commandId, "cancel_all_123");
    assert.equal(entry.userId, "user_123");
    assert.equal(entry.symbol, "ETHUSDT");
    assert.equal(entry.orderId, undefined);
    assert.equal(entry.metadata, "{}");

    assert.deepEqual(parseOrderCancelAllStreamEntry(entry), {
        schemaVersion: "1",
        messageType: ORDER_COMMAND_TYPES.cancelAll,
        commandId: "cancel_all_123",
        userId: "user_123",
        symbol: "ETHUSDT",
        requestId: "req_cancel_all",
        source: "backend",
        createdAt: "2026-05-16T00:00:00.000Z",
        metadata: {},
    });
    assert.equal(parseOrderCommandStreamEntry(entry).messageType, ORDER_COMMAND_TYPES.cancelAll);
});

test("validates cancel and cancel-all ownership fields", () => {
    assert.match(
        validateOrderCancelCommand({
            commandId: "cancel_123",
            orderId: "order_123",
            symbol: "BTCUSDT",
            createdAt: "2026-05-16T00:00:00.000Z",
        }).join("\n"),
        /userId is required/,
    );

    assert.match(
        validateOrderCancelAllCommand({
            commandId: "cancel_all_123",
            userId: "user_123",
            createdAt: "2026-05-16T00:00:00.000Z",
        }).join("\n"),
        /symbol is required/,
    );
});

test("defaults missing metadata to an empty object in stream entries", () => {
    const entry = buildOrderSubmitStreamEntry({
        ...baseCommand,
        metadata: undefined,
    });

    assert.equal(entry.metadata, "{}");
    assert.deepEqual(parseOrderSubmitStreamEntry(entry).metadata, {});
});

test("supports environment overrides for stream names and consumer behavior", () => {
    const config = getOrderStreamConfig({
        ORDER_COMMAND_STREAM: "orders:commands:test",
        ORDER_COMMAND_DLQ_STREAM: "orders:commands:dlq:test",
        ORDER_EVENT_STREAM: "orders:events:test",
        ORDER_COMMAND_CONSUMER_GROUP: "execution:test",
        ORDER_COMMAND_READ_COUNT: "25",
        ORDER_COMMAND_CLAIM_IDLE_MS: "45000",
        ORDER_COMMAND_MAX_ATTEMPTS: "7",
    });

    assert.equal(config.streams.commands, "orders:commands:test");
    assert.equal(config.streams.commandDlq, "orders:commands:dlq:test");
    assert.equal(config.streams.events, "orders:events:test");
    assert.equal(config.consumerGroups.execution, "execution:test");
    assert.equal(config.readCount, 25);
    assert.equal(config.claimIdleMs, 45000);
    assert.equal(config.maxAttempts, 7);
});

test("uses stable default stream names", () => {
    assert.deepEqual(getOrderStreamConfig({}).streams, ORDER_STREAMS);
});

test("creates Redis-safe consumer names", () => {
    assert.equal(
        createOrderCommandConsumerName({
            service: "execution service",
            hostname: "dev machine",
            instanceId: "worker#1",
        }),
        "execution-service:dev-machine:worker-1",
    );
});

test("builds dead-letter entries without requiring credential material", () => {
    const entry = buildOrderCommandDeadLetterEntry({
        originalStreamId: "1715712000000-0",
        reason: "validation failed",
        command: baseCommand,
        attempts: 5,
        failedAt: "2026-05-15T00:01:00.000Z",
    });

    assert.equal(entry.messageType, ORDER_EVENT_TYPES.deadLettered);
    assert.equal(entry.originalStreamId, "1715712000000-0");
    assert.equal(entry.commandId, "cmd_123");
    assert.equal(entry.orderId, "order_123");
    assert.equal(entry.userId, "user_123");
    assert.equal(entry.attempts, "5");
    assert.doesNotMatch(entry.payload, /apiKey|secret|signature|token/i);
});
