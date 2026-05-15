import assert from "node:assert/strict";
import test from "node:test";

import {
    normalizeExecutionOrderCommand,
    parseLegacyOrderCommandMessage,
    processOrderCommand,
} from "./orderCommandProcessor.js";

function createMemoryPrisma(existingCommands = []) {
    const commands = new Map(existingCommands.map((command) => [command.orderId, { ...command }]));
    const events = [];

    return {
        commands,
        events,
        orderCommand: {
            findUnique: async ({ where }) => {
                const row = commands.get(where.orderId);
                return row ? { ...row } : null;
            },
            upsert: async ({ where, update, create }) => {
                const existing = commands.get(where.orderId);
                const next = existing ? { ...existing, ...update } : { ...create };
                commands.set(where.orderId, next);
                return { ...next };
            },
        },
        orderEvent: {
            create: async ({ data }) => {
                events.push({ ...data });
                return { ...data };
            },
        },
    };
}

function createPub() {
    const messages = [];

    return {
        messages,
        publish: async (channel, message) => {
            messages.push({ channel, message: JSON.parse(message) });
            return 1;
        },
    };
}

test("normalizes legacy Pub/Sub command messages", () => {
    const command = parseLegacyOrderCommandMessage(JSON.stringify({
        orderId: "order_123",
        userId: "user_123",
        symbol: "btcusdt",
        side: "buy",
        type: "market",
        quantity: 0.001,
    }));

    assert.deepEqual(command, {
        commandId: "order_123",
        orderId: "order_123",
        userId: "user_123",
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quantity: "0.001",
        price: undefined,
        stopPrice: undefined,
        timeInForce: undefined,
    });
});

test("submits order through Binance with clientOrderId and publishes scoped event", async () => {
    const prisma = createMemoryPrisma();
    const pub = createPub();
    const userStreams = [];
    const executed = [];

    const result = await processOrderCommand({
        command: normalizeExecutionOrderCommand({
            orderId: "order_123",
            userId: "user_123",
            symbol: "BTCUSDT",
            side: "BUY",
            orderType: "LIMIT",
            quantity: "0.001",
            price: "65000.25",
            timeInForce: "GTC",
        }),
        prisma,
        pub,
        eventsChannel: "events:order:status",
        loadActiveExchangeCredential: async () => ({ apiKey: "api-key", secretKey: "secret-key" }),
        startUserDataStream: (args) => userStreams.push(args),
        executeBinanceOrder: async (args) => {
            executed.push(args);
            return { orderId: 98765, clientOrderId: args.clientOrderId, transactTime: Date.parse("2026-05-16T00:00:00.000Z") };
        },
    });

    assert.equal(result.outcome, "submitted");
    assert.equal(executed[0].clientOrderId, "order_123");
    assert.equal(executed[0].quantity, "0.001");
    assert.equal(userStreams[0].userId, "user_123");
    assert.equal(prisma.commands.get("order_123").status, "SUBMITTED");
    assert.equal(prisma.commands.get("order_123").binanceOrderId, 98765);
    assert.equal(pub.messages[0].channel, "events:order:status");
    assert.equal(pub.messages[0].message.userId, "user_123");
    assert.equal(pub.messages[0].message.status, "SUBMITTED");
});

test("rejects command when credentials cannot be loaded", async () => {
    const prisma = createMemoryPrisma();
    const pub = createPub();

    const result = await processOrderCommand({
        command: {
            orderId: "order_123",
            userId: "user_123",
            symbol: "BTCUSDT",
            side: "SELL",
            orderType: "MARKET",
            quantity: "0.001",
        },
        prisma,
        pub,
        eventsChannel: "events:order:status",
        loadActiveExchangeCredential: async () => {
            throw new Error("Exchange credential not found");
        },
        startUserDataStream: () => assert.fail("stream should not start without credentials"),
        executeBinanceOrder: () => assert.fail("order should not execute without credentials"),
    });

    assert.equal(result.outcome, "rejected");
    assert.equal(prisma.commands.get("order_123").status, "REJECTED");
    assert.equal(prisma.events[0].status, "REJECTED");
    assert.equal(pub.messages[0].message.status, "REJECTED");
    assert.match(pub.messages[0].message.reason, /credential/i);
});

test("skips already submitted commands before placing another Binance order", async () => {
    const pub = createPub();
    const prisma = createMemoryPrisma([{
        orderId: "order_123",
        userId: "user_123",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        quantity: 0.001,
        status: "SUBMITTED",
        binanceOrderId: 98765,
        submittedAt: new Date("2026-05-16T00:00:00.000Z"),
    }]);

    const result = await processOrderCommand({
        command: {
            orderId: "order_123",
            userId: "user_123",
            symbol: "BTCUSDT",
            side: "BUY",
            orderType: "MARKET",
            quantity: "0.001",
        },
        prisma,
        pub,
        eventsChannel: "events:order:status",
        loadActiveExchangeCredential: () => assert.fail("credentials should not load for submitted duplicate"),
        startUserDataStream: () => assert.fail("stream should not start for submitted duplicate"),
        executeBinanceOrder: () => assert.fail("order should not execute twice"),
    });

    assert.equal(result.outcome, "skipped");
    assert.equal(pub.messages[0].message.status, "SUBMITTED");
    assert.equal(pub.messages[0].message.binance.orderId, 98765);
});
