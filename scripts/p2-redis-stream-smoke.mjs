import assert from "node:assert/strict";
import { createClient } from "redis";

import {
    buildOrderSubmitStreamEntry,
    parseOrderSubmitStreamEntry,
} from "@tradeco/redis-stream-contracts";
import {
    ensureOrderConsumerGroup,
    handleOrderStreamMessage,
    readNewOrderStreamMessages,
} from "../apps/execution-service/src/redisOrderStreamConsumer.js";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const runId = process.env.TRADECO_SMOKE_RUN_ID || `${Date.now()}-${process.pid}`;
const streamName = `tradeco:smoke:orders:commands:${runId}`;
const dlqStreamName = `tradeco:smoke:orders:commands:dlq:${runId}`;
const groupName = `tradeco:smoke:execution:${runId}`;
const consumerName = `smoke:${process.pid}`;
const connectTimeoutMs = readPositiveInteger("REDIS_CONNECT_TIMEOUT_MS", 3000);
const commandTimeoutMs = readPositiveInteger("REDIS_COMMAND_TIMEOUT_MS", 3000);

let lastRedisError;
const redis = createClient({
    url: redisUrl,
    socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: false,
    },
});
redis.on("error", (error) => {
    lastRedisError = error;
});

try {
    await withTimeout(
        redis.connect(),
        connectTimeoutMs + 1000,
        `Timed out connecting to Redis at ${redactRedisUrl(redisUrl)}`,
    );
    await withTimeout(
        redis.ping(),
        commandTimeoutMs,
        `Timed out pinging Redis at ${redactRedisUrl(redisUrl)}`,
    );
    await redis.del(streamName, dlqStreamName);

    await ensureOrderConsumerGroup({ redis, streamName, groupName });

    const validEntry = buildOrderSubmitStreamEntry({
        commandId: `cmd_${runId}`,
        orderId: `order_${runId}`,
        userId: "smoke_user",
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quantity: "0.001",
        createdAt: "2026-05-16T00:00:00.000Z",
        metadata: {},
    });

    const validId = await redis.xAdd(streamName, "*", validEntry);
    const validMessages = await readWithTimeout();

    assert.equal(validMessages.length, 1, "expected one valid stream message");
    assert.equal(validMessages[0].id, validId);

    const processed = [];
    const validResult = await handleOrderStreamMessage({
        redis,
        streamName,
        groupName,
        dlqStreamName,
        maxAttempts: 3,
        message: validMessages[0],
        processCommand: async (command) => {
            processed.push(command);
            assert.deepEqual(command, parseOrderSubmitStreamEntry(validEntry));
            return { outcome: "submitted" };
        },
    });

    assert.equal(validResult.outcome, "acked");
    assert.equal(processed.length, 1, "valid command should be processed exactly once");
    await assertNoPendingMessages();

    const invalidId = await redis.xAdd(streamName, "*", {
        schemaVersion: "1",
        messageType: "order.submit.requested.v1",
        orderId: `invalid_${runId}`,
    });
    const invalidMessages = await readWithTimeout();

    assert.equal(invalidMessages.length, 1, "expected one invalid stream message");
    assert.equal(invalidMessages[0].id, invalidId);

    const invalidResult = await handleOrderStreamMessage({
        redis,
        streamName,
        groupName,
        dlqStreamName,
        maxAttempts: 3,
        message: invalidMessages[0],
        processCommand: async () => assert.fail("invalid command should not be processed"),
    });

    assert.equal(invalidResult.outcome, "dead-lettered");
    assert.equal(invalidResult.reason, "invalid");
    await assertNoPendingMessages();

    const dlqEntries = await redis.xRange(dlqStreamName, "-", "+");
    assert.equal(dlqEntries.length, 1, "expected one DLQ entry");

    const dlqFields = dlqEntries[0].message || dlqEntries[0].fields || {};
    assert.equal(dlqFields.originalStreamId, invalidId);
    assert.equal(dlqFields.messageType, "order.command.dead_lettered.v1");
    assert.match(dlqFields.reason, /Invalid stream command/);
    assert.doesNotMatch(JSON.stringify(dlqFields), /apiKey|secret|signature|token/i);

    console.log("p2 redis stream smoke checks passed", {
        streamName,
        dlqStreamName,
        validId,
        invalidId,
    });
} catch (error) {
    const message = formatErrorMessage(error);
    console.error("p2 redis stream smoke checks failed:", message);
    if (lastRedisError) {
        console.error("last Redis client error:", formatErrorMessage(lastRedisError));
    }
    if (/AggregateError|ECONNREFUSED|ENOTFOUND|Socket closed|Operation not permitted|connect|Redis/i.test(message)) {
        console.error("Start local Redis first with: npm run dev:infra:up");
    }
    process.exitCode = 1;
} finally {
    if (redis.isOpen) {
        await redis.del(streamName, dlqStreamName).catch(() => {});
        await redis.quit().catch(() => destroyRedisClient());
    } else {
        destroyRedisClient();
    }
}

async function assertNoPendingMessages() {
    const summary = await redis.xPending(streamName, groupName);
    const pending = Number(summary?.pending ?? summary?.count ?? summary?.[0] ?? 0);
    assert.equal(pending, 0, "expected no pending stream messages");
}

async function readWithTimeout() {
    return await withTimeout(
        readNewOrderStreamMessages({
            redis,
            streamName,
            groupName,
            consumerName,
            count: 1,
            blockMs: 1000,
        }),
        commandTimeoutMs + 1000,
        "Timed out reading from Redis Stream",
    );
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timeoutId);
    }
}

function readPositiveInteger(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function redactRedisUrl(value) {
    try {
        const url = new URL(value);
        if (url.password) url.password = "redacted";
        if (url.username) url.username = "redacted";
        return url.toString();
    } catch {
        return "<invalid REDIS_URL>";
    }
}

function formatErrorMessage(error) {
    if (error instanceof AggregateError) {
        return [
            String(error.message || "AggregateError"),
            ...error.errors.map((item) => formatErrorMessage(item)),
        ].join("; ");
    }

    return String(error?.message || error);
}

function destroyRedisClient() {
    try {
        redis.destroy();
    } catch (error) {
        if (!/client is closed/i.test(String(error?.message || error))) {
            throw error;
        }
    }
}
