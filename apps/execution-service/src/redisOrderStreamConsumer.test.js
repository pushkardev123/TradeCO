import assert from "node:assert/strict";
import test from "node:test";

import { buildOrderSubmitStreamEntry } from "@tradeco/redis-stream-contracts";
import {
    ensureOrderConsumerGroup,
    flattenRedisStreamMessages,
    handleOrderStreamMessage,
    readNewOrderStreamMessages,
} from "./redisOrderStreamConsumer.js";

function validStreamFields(overrides = {}) {
    return buildOrderSubmitStreamEntry({
        commandId: "order_123",
        orderId: "order_123",
        userId: "user_123",
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quantity: "0.001",
        createdAt: "2026-05-16T00:00:00.000Z",
        metadata: {},
        ...overrides,
    });
}

function createRedis({ deliveriesCounter = 1 } = {}) {
    const calls = [];

    return {
        calls,
        xAck: async (...args) => {
            calls.push(["xAck", ...args]);
            return 1;
        },
        xAdd: async (...args) => {
            calls.push(["xAdd", ...args]);
            return "1715712000000-1";
        },
        xPendingRange: async () => [{ id: "1715712000000-0", deliveriesCounter }],
    };
}

test("ensureOrderConsumerGroup creates group and ignores BUSYGROUP", async () => {
    const created = [];
    await ensureOrderConsumerGroup({
        redis: {
            xGroupCreate: async (...args) => created.push(args),
        },
        streamName: "orders",
        groupName: "execution",
    });
    assert.deepEqual(created, [["orders", "execution", "0", { MKSTREAM: true }]]);

    await ensureOrderConsumerGroup({
        redis: {
            xGroupCreate: async () => {
                throw new Error("BUSYGROUP Consumer Group name already exists");
            },
        },
        streamName: "orders",
        groupName: "execution",
    });
});

test("readNewOrderStreamMessages reads with consumer group and flattens response", async () => {
    const redis = {
        xReadGroup: async (...args) => {
            assert.deepEqual(args, [
                "execution",
                "consumer-1",
                [{ key: "orders", id: ">" }],
                { COUNT: 10, BLOCK: 5000 },
            ]);
            return [{
                name: "orders",
                messages: [{ id: "1715712000000-0", message: { field: "value" } }],
            }];
        },
    };

    assert.deepEqual(await readNewOrderStreamMessages({
        redis,
        streamName: "orders",
        groupName: "execution",
        consumerName: "consumer-1",
        count: 10,
    }), [{
        streamName: "orders",
        id: "1715712000000-0",
        fields: { field: "value" },
    }]);

    assert.deepEqual(flattenRedisStreamMessages(null), []);
});

test("handleOrderStreamMessage processes valid command and acknowledges it", async () => {
    const redis = createRedis();
    const processed = [];

    const result = await handleOrderStreamMessage({
        redis,
        streamName: "orders",
        groupName: "execution",
        dlqStreamName: "orders:dlq",
        maxAttempts: 3,
        message: { id: "1715712000000-0", fields: validStreamFields() },
        processCommand: async (command) => processed.push(command),
    });

    assert.equal(result.outcome, "acked");
    assert.equal(processed[0].orderId, "order_123");
    assert.deepEqual(redis.calls, [["xAck", "orders", "execution", "1715712000000-0"]]);
});

test("handleOrderStreamMessage dead-letters invalid commands and acknowledges them", async () => {
    const redis = createRedis();

    const result = await handleOrderStreamMessage({
        redis,
        streamName: "orders",
        groupName: "execution",
        dlqStreamName: "orders:dlq",
        maxAttempts: 3,
        message: { id: "1715712000000-0", fields: { orderId: "order_123" } },
        processCommand: () => assert.fail("invalid command should not process"),
    });

    assert.equal(result.outcome, "dead-lettered");
    assert.equal(redis.calls[0][0], "xAdd");
    assert.equal(redis.calls[0][1], "orders:dlq");
    assert.equal(redis.calls[1][0], "xAck");
});

test("handleOrderStreamMessage leaves failed commands pending until max attempts", async () => {
    const redis = createRedis({ deliveriesCounter: 2 });

    await assert.rejects(
        () => handleOrderStreamMessage({
            redis,
            streamName: "orders",
            groupName: "execution",
            dlqStreamName: "orders:dlq",
            maxAttempts: 3,
            message: { id: "1715712000000-0", fields: validStreamFields() },
            processCommand: async () => {
                throw new Error("database unavailable");
            },
        }),
        /database unavailable/,
    );

    assert.deepEqual(redis.calls, []);
});

test("handleOrderStreamMessage dead-letters failed commands at max attempts", async () => {
    const redis = createRedis({ deliveriesCounter: 3 });

    const result = await handleOrderStreamMessage({
        redis,
        streamName: "orders",
        groupName: "execution",
        dlqStreamName: "orders:dlq",
        maxAttempts: 3,
        message: { id: "1715712000000-0", fields: validStreamFields() },
        processCommand: async () => {
            throw new Error("database unavailable");
        },
    });

    assert.equal(result.outcome, "dead-lettered");
    assert.equal(redis.calls[0][0], "xAdd");
    assert.equal(redis.calls[0][1], "orders:dlq");
    assert.equal(redis.calls[1][0], "xAck");
});
