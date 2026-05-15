import assert from "node:assert/strict";
import { createClient } from "redis";

import {
    appendOrderSubmitStreamEntry,
    createOrderSubmitDraftFromRequest,
} from "../apps/backend/src/orderStreamProducer.js";
import {
    processOrderCommand,
} from "../apps/execution-service/src/orderCommandProcessor.js";
import {
    ensureOrderConsumerGroup,
    handleOrderStreamMessage,
    readNewOrderStreamMessages,
} from "../apps/execution-service/src/redisOrderStreamConsumer.js";
import {
    canReceiveBroadcast,
    shouldBroadcastChannelMessage,
} from "../apps/event-service/src/auth.js";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const runId = process.env.TRADECO_SMOKE_RUN_ID || `${Date.now()}-${process.pid}`;
const streamName = `tradeco:smoke:e2e:orders:commands:${runId}`;
const dlqStreamName = `tradeco:smoke:e2e:orders:commands:dlq:${runId}`;
const groupName = `tradeco:smoke:e2e:execution:${runId}`;
const consumerName = `smoke-e2e:${process.pid}`;
const eventsChannel = process.env.EVENTS_CHANNEL || "events:order:status";
const connectTimeoutMs = readPositiveInteger("REDIS_CONNECT_TIMEOUT_MS", 3000);
const commandTimeoutMs = readPositiveInteger("REDIS_COMMAND_TIMEOUT_MS", 3000);

let redis;
let lastRedisError;

try {
    redis = await connectRedis();
    await redis.del(streamName, dlqStreamName);

    const prisma = createMemoryPrisma();
    const authenticatedUserId = `user_${runId}`;
    const attackerUserId = `attacker_${runId}`;
    const orderId = `order_${runId}`;

    const orderDraft = createOrderSubmitDraftFromRequest({
        body: {
            userId: attackerUserId,
            symbol: "btcusdt",
            side: "buy",
            orderType: "market",
            quantity: "0.001",
            meta: {
                apiKey: "must-not-enter-stream",
            },
        },
        userId: authenticatedUserId,
        orderId,
        requestId: `request_${runId}`,
        createdAt: new Date("2026-05-16T00:00:00.000Z"),
    });

    assert.equal(orderDraft.userId, authenticatedUserId);
    assert.equal(orderDraft.streamEntry.userId, authenticatedUserId);
    assert.doesNotMatch(JSON.stringify(orderDraft.streamEntry), /attacker_|apiKey|must-not-enter-stream/i);

    await prisma.orderCommand.create({
        data: {
            userId: authenticatedUserId,
            orderId,
            symbol: orderDraft.symbol,
            side: orderDraft.side,
            type: orderDraft.orderType,
            quantity: orderDraft.quantity,
            price: null,
            stopPrice: null,
            timeInForce: null,
            status: "RECEIVED",
        },
    });

    const streamId = await appendOrderSubmitStreamEntry({
        redis,
        streamName,
        streamEntry: orderDraft.streamEntry,
    });

    await redis.quit();

    redis = await connectRedis();
    await ensureOrderConsumerGroup({ redis, streamName, groupName });

    const messages = await readWithTimeout();
    assert.equal(messages.length, 1, "expected one queued market order command after execution restart");
    assert.equal(messages[0].id, streamId);

    const pub = createMemoryPublisher();
    const startedUserStreams = [];
    const executedOrders = [];

    const result = await handleOrderStreamMessage({
        redis,
        streamName,
        groupName,
        dlqStreamName,
        maxAttempts: 3,
        message: messages[0],
        processCommand: async (command) => processOrderCommand({
            command,
            prisma,
            pub,
            eventsChannel,
            loadActiveExchangeCredential: async (_prisma, userId) => {
                assert.equal(userId, authenticatedUserId);
                return { apiKey: "testnet-api-key", secretKey: "testnet-secret-key" };
            },
            startUserDataStream: ({ userId }) => startedUserStreams.push({ userId }),
            executeBinanceOrder: async (order) => {
                executedOrders.push(order);
                assert.equal(order.clientOrderId, orderId);
                assert.equal(order.symbol, "BTCUSDT");
                assert.equal(order.orderType, "MARKET");
                assert.equal(order.quantity, "0.001");
                return {
                    orderId: 123456789,
                    clientOrderId: order.clientOrderId,
                    status: "FILLED",
                    executedQty: "0.001",
                    cummulativeQuoteQty: "65.00",
                    transactTime: Date.parse("2026-05-16T00:00:01.000Z"),
                };
            },
        }),
    });

    assert.equal(result.outcome, "acked");
    assert.equal(startedUserStreams.length, 1);
    assert.equal(startedUserStreams[0].userId, authenticatedUserId);
    assert.equal(executedOrders.length, 1);

    const persistedOrder = prisma.commands.get(orderId);
    assert.equal(persistedOrder.status, "FILLED");
    assert.equal(persistedOrder.rawStatus, "FILLED");
    assert.equal(persistedOrder.userId, authenticatedUserId);
    assert.equal(persistedOrder.binanceOrderId, 123456789);

    assert.equal(prisma.events.length, 1, "expected successful execution to persist an order event");
    assert.equal(prisma.events[0].status, "FILLED");
    assert.equal(prisma.events[0].userId, authenticatedUserId);
    assert.equal(prisma.events[0].price, "65000");

    const published = pub.messages.find((message) => message.channel === eventsChannel);
    assert.ok(published, "expected a scoped order status event");
    assert.equal(published.body.userId, authenticatedUserId);
    assert.equal(published.body.status, "FILLED");
    assert.equal(published.body.orderId, orderId);
    assert.doesNotMatch(published.raw, /testnet-api-key|testnet-secret-key|signature|token/i);

    const scopedChannels = [eventsChannel];
    assert.equal(shouldBroadcastChannelMessage({
        channel: eventsChannel,
        message: published.raw,
        scopedChannels,
    }), true);
    assert.equal(canReceiveBroadcast({
        ws: { user: { id: authenticatedUserId } },
        channel: eventsChannel,
        message: published.raw,
        scopedChannels,
    }), true);
    assert.equal(canReceiveBroadcast({
        ws: { user: { id: "other_user" } },
        channel: eventsChannel,
        message: published.raw,
        scopedChannels,
    }), false);

    await assertNoPendingMessages();
    assert.equal(await redis.xLen(dlqStreamName), 0, "expected no DLQ entries for the happy path");

    console.log("p2 e2e market order smoke checks passed", {
        streamName,
        streamId,
        orderId,
        status: persistedOrder.status,
    });
} catch (error) {
    const message = formatErrorMessage(error);
    console.error("p2 e2e market order smoke checks failed:", message);
    if (lastRedisError) {
        console.error("last Redis client error:", formatErrorMessage(lastRedisError));
    }
    if (/AggregateError|ECONNREFUSED|ENOTFOUND|Socket closed|Operation not permitted|connect|Redis/i.test(message)) {
        console.error("Start local Redis first with: npm run dev:infra:up");
    }
    process.exitCode = 1;
} finally {
    await cleanupStreams();
}

async function connectRedis() {
    const client = createClient({
        url: redisUrl,
        socket: {
            connectTimeout: connectTimeoutMs,
            reconnectStrategy: false,
        },
    });
    client.on("error", (error) => {
        lastRedisError = error;
    });

    await withTimeout(
        client.connect(),
        connectTimeoutMs + 1000,
        `Timed out connecting to Redis at ${redactRedisUrl(redisUrl)}`,
    );
    await withTimeout(
        client.ping(),
        commandTimeoutMs,
        `Timed out pinging Redis at ${redactRedisUrl(redisUrl)}`,
    );

    return client;
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

async function assertNoPendingMessages() {
    const summary = await redis.xPending(streamName, groupName);
    const pending = Number(summary?.pending ?? summary?.count ?? summary?.[0] ?? 0);
    assert.equal(pending, 0, "expected no pending stream messages");
}

async function cleanupStreams() {
    let cleanupClient = redis;

    try {
        if (!cleanupClient?.isOpen) {
            cleanupClient = await connectRedis();
        }

        await cleanupClient.del(streamName, dlqStreamName).catch(() => {});
    } catch {
        // Best-effort cleanup only. Smoke stream names are run-specific.
    } finally {
        if (cleanupClient?.isOpen) {
            await cleanupClient.quit().catch(() => destroyRedisClient(cleanupClient));
        } else if (cleanupClient) {
            destroyRedisClient(cleanupClient);
        }
    }
}

function createMemoryPublisher() {
    const messages = [];

    return {
        messages,
        publish: async (channel, raw) => {
            messages.push({ channel, raw, body: JSON.parse(raw) });
            return 1;
        },
    };
}

function createMemoryPrisma() {
    const commands = new Map();
    const events = [];

    return {
        commands,
        events,
        orderCommand: {
            create: async ({ data }) => {
                if (commands.has(data.orderId)) {
                    const error = new Error("Unique constraint failed on orderId");
                    error.code = "P2002";
                    throw error;
                }

                const row = {
                    id: `cmd_${commands.size + 1}`,
                    submittedAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...data,
                };
                commands.set(data.orderId, row);
                return { ...row };
            },
            findUnique: async ({ where }) => {
                const row = commands.get(where.orderId);
                return row ? { ...row } : null;
            },
            upsert: async ({ where, update, create }) => {
                const existing = commands.get(where.orderId);
                const row = existing
                    ? { ...existing, ...update, updatedAt: new Date() }
                    : { id: `cmd_${commands.size + 1}`, createdAt: new Date(), updatedAt: new Date(), ...create };
                commands.set(where.orderId, row);
                return { ...row };
            },
            update: async ({ where, data }) => {
                const existing = commands.get(where.orderId);
                if (!existing) throw new Error("OrderCommand not found");
                const row = { ...existing, ...data, updatedAt: new Date() };
                commands.set(where.orderId, row);
                return { ...row };
            },
        },
        orderEvent: {
            create: async ({ data }) => {
                const row = {
                    id: `evt_${events.length + 1}`,
                    createdAt: new Date(),
                    ...data,
                };
                events.push(row);
                return { ...row };
            },
        },
    };
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

function destroyRedisClient(client) {
    try {
        client.destroy();
    } catch (error) {
        if (!/client is closed/i.test(String(error?.message || error))) {
            throw error;
        }
    }
}
