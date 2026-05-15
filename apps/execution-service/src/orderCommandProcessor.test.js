import assert from "node:assert/strict";
import test from "node:test";

import {
    normalizeExecutionCancelAllCommand,
    normalizeExecutionCancelCommand,
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
            findMany: async ({ where, orderBy } = {}) => {
                let rows = Array.from(commands.values());
                if (where?.userId !== undefined) rows = rows.filter((row) => row.userId === where.userId);
                if (where?.symbol !== undefined) rows = rows.filter((row) => row.symbol === where.symbol);
                if (where?.status?.in) rows = rows.filter((row) => where.status.in.includes(row.status));
                if (where?.orderId?.in) rows = rows.filter((row) => where.orderId.in.includes(row.orderId));
                if (orderBy?.createdAt === "desc") {
                    rows = rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
                }
                return rows.map((row) => ({ ...row }));
            },
            upsert: async ({ where, update, create }) => {
                const existing = commands.get(where.orderId);
                const next = existing ? { ...existing, ...update } : { ...create };
                commands.set(where.orderId, next);
                return { ...next };
            },
            update: async ({ where, data }) => {
                const existing = commands.get(where.orderId);
                if (!existing) throw new Error("OrderCommand not found");
                const next = { ...existing, ...data };
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
    assert.equal(userStreams[0].secretKey, "secret-key");
    assert.equal(prisma.commands.get("order_123").status, "SUBMITTED");
    assert.equal(prisma.commands.get("order_123").binanceOrderId, 98765);
    assert.equal(prisma.events[0].status, "SUBMITTED");
    assert.equal(prisma.events[0].userId, "user_123");
    assert.equal(pub.messages[0].channel, "events:order:status");
    assert.equal(pub.messages[0].message.userId, "user_123");
    assert.equal(pub.messages[0].message.status, "SUBMITTED");
});

test("persists and broadcasts filled market order status from Binance response", async () => {
    const prisma = createMemoryPrisma();
    const pub = createPub();

    const result = await processOrderCommand({
        command: {
            orderId: "order_market_123",
            userId: "user_123",
            symbol: "BTCUSDT",
            side: "BUY",
            orderType: "MARKET",
            quantity: "0.001",
        },
        prisma,
        pub,
        eventsChannel: "events:order:status",
        loadActiveExchangeCredential: async () => ({ apiKey: "api-key", secretKey: "secret-key" }),
        startUserDataStream: () => {},
        executeBinanceOrder: async (args) => ({
            orderId: 54321,
            clientOrderId: args.clientOrderId,
            status: "FILLED",
            executedQty: "0.001",
            cummulativeQuoteQty: "65.00",
            transactTime: Date.parse("2026-05-16T00:00:00.000Z"),
        }),
    });

    assert.equal(result.outcome, "submitted");
    assert.equal(prisma.commands.get("order_market_123").status, "FILLED");
    assert.equal(prisma.commands.get("order_market_123").rawStatus, "FILLED");
    assert.equal(prisma.commands.get("order_market_123").executedQty, "0.001");
    assert.equal(prisma.commands.get("order_market_123").avgFillPrice, "65000");
    assert.equal(prisma.events[0].status, "FILLED");
    assert.equal(prisma.events[0].price, "65000");
    assert.equal(pub.messages[0].message.status, "FILLED");
    assert.equal(pub.messages[0].message.price, "65000");
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
    assert.equal(pub.messages[0].message.quantity, "0.001");
    assert.equal(pub.messages[0].message.binance.orderId, 98765);
});

test("cancels one open order through Binance and publishes scoped lifecycle events", async () => {
    const pub = createPub();
    const prisma = createMemoryPrisma([{
        orderId: "order_123",
        userId: "user_123",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.001,
        price: 65000,
        status: "SUBMITTED",
        binanceOrderId: 98765,
        createdAt: new Date("2026-05-16T00:00:00.000Z"),
    }]);
    const startedUserStreams = [];
    const canceled = [];

    const result = await processOrderCommand({
        command: normalizeExecutionCancelCommand({
            commandId: "cancel_123",
            orderId: "order_123",
            userId: "user_123",
            symbol: "btcusdt",
        }),
        prisma,
        pub,
        eventsChannel: "events:order:status",
        loadActiveExchangeCredential: async () => ({ apiKey: "api-key", secretKey: "secret-key" }),
        startUserDataStream: (args) => startedUserStreams.push(args),
        executeBinanceCancelOrder: async (args) => {
            canceled.push(args);
            return {
                symbol: "BTCUSDT",
                orderId: args.binanceOrderId,
                origClientOrderId: args.orderId,
                status: "CANCELED",
                executedQty: "0.000",
                cummulativeQuoteQty: "0.000",
                updateTime: Date.parse("2026-05-16T00:00:05.000Z"),
            };
        },
    });

    assert.equal(result.outcome, "canceled");
    assert.equal(startedUserStreams[0].userId, "user_123");
    assert.equal(startedUserStreams[0].secretKey, "secret-key");
    assert.equal(canceled[0].symbol, "BTCUSDT");
    assert.equal(canceled[0].orderId, "order_123");
    assert.equal(canceled[0].binanceOrderId, 98765);
    assert.equal(prisma.commands.get("order_123").status, "CANCELED");
    assert.equal(prisma.commands.get("order_123").rawStatus, "CANCELED");
    assert.equal(prisma.events[0].status, "CANCEL_PENDING");
    assert.equal(prisma.events[1].status, "CANCELED");
    assert.equal(pub.messages.at(-1).message.userId, "user_123");
    assert.equal(pub.messages.at(-1).message.status, "CANCELED");
    assert.doesNotMatch(JSON.stringify(pub.messages), /api-key|secret-key|signature|token/i);
});

test("cancel-all cancels local open orders returned by Binance", async () => {
    const pub = createPub();
    const prisma = createMemoryPrisma([
        {
            orderId: "order_a",
            userId: "user_123",
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            quantity: 0.001,
            status: "SUBMITTED",
            binanceOrderId: 111,
            createdAt: new Date("2026-05-16T00:00:00.000Z"),
        },
        {
            orderId: "order_b",
            userId: "user_123",
            symbol: "BTCUSDT",
            side: "SELL",
            type: "LIMIT",
            quantity: 0.002,
            status: "PARTIALLY_FILLED",
            binanceOrderId: 222,
            createdAt: new Date("2026-05-16T00:00:01.000Z"),
        },
        {
            orderId: "order_other_symbol",
            userId: "user_123",
            symbol: "ETHUSDT",
            side: "BUY",
            type: "LIMIT",
            quantity: 0.01,
            status: "SUBMITTED",
            binanceOrderId: 333,
            createdAt: new Date("2026-05-16T00:00:02.000Z"),
        },
    ]);
    const canceledAll = [];

    const result = await processOrderCommand({
        command: normalizeExecutionCancelAllCommand({
            commandId: "cancel_all_123",
            userId: "user_123",
            symbol: "btcusdt",
        }),
        prisma,
        pub,
        eventsChannel: "events:order:status",
        loadActiveExchangeCredential: async () => ({ apiKey: "api-key", secretKey: "secret-key" }),
        startUserDataStream: () => {},
        executeBinanceCancelAllOrders: async (args) => {
            canceledAll.push(args);
            return [
                { symbol: "BTCUSDT", orderId: 111, origClientOrderId: "order_a", status: "CANCELED", executedQty: "0", cummulativeQuoteQty: "0" },
                { symbol: "BTCUSDT", orderId: 222, origClientOrderId: "order_b", status: "CANCELED", executedQty: "0.001", cummulativeQuoteQty: "65.00" },
            ];
        },
    });

    assert.equal(result.outcome, "cancel-all-submitted");
    assert.equal(result.affectedCount, 2);
    assert.equal(result.canceledCount, 2);
    assert.equal(canceledAll[0].symbol, "BTCUSDT");
    assert.equal(prisma.commands.get("order_a").status, "CANCELED");
    assert.equal(prisma.commands.get("order_b").status, "CANCELED");
    assert.equal(prisma.commands.get("order_other_symbol").status, "SUBMITTED");
    assert.equal(pub.messages.filter((message) => message.message.status === "CANCELED").length, 2);
});
