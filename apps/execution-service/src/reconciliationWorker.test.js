import assert from "node:assert/strict";
import test from "node:test";

import {
    normalizeAccountBalances,
    runReconciliationCycle,
} from "./reconciliationWorker.js";

function createMemoryPrisma(existingCommands = []) {
    const commands = new Map(existingCommands.map((command) => [command.orderId, { ...command }]));
    const events = [];

    return {
        commands,
        events,
        orderCommand: {
            findMany: async ({ where, orderBy, take } = {}) => {
                let rows = Array.from(commands.values());
                if (where?.status?.in) rows = rows.filter((row) => where.status.in.includes(row.status));
                if (where?.updatedAt?.lt) rows = rows.filter((row) => new Date(row.updatedAt || 0) < where.updatedAt.lt);
                if (orderBy?.updatedAt === "asc") {
                    rows = rows.sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));
                }
                return rows.slice(0, take || rows.length).map((row) => ({ ...row }));
            },
            update: async ({ where, data }) => {
                const existing = commands.get(where.orderId);
                if (!existing) throw new Error("OrderCommand not found");
                const next = { ...existing, ...data, updatedAt: new Date("2026-05-16T00:01:00.000Z") };
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

function noopLogger() {
    return { log() { }, warn() { } };
}

test("reconciles filled Binance order with Decimal strings and scoped events", async () => {
    const prisma = createMemoryPrisma([{
        orderId: "order_123",
        userId: "user_123",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        quantity: "0.001",
        status: "SUBMITTED",
        rawStatus: "NEW",
        executedQty: "0",
        cummulativeQuoteQty: "0",
        updatedAt: new Date("2026-05-16T00:00:00.000Z"),
    }]);
    const pub = createPub();

    const summary = await runReconciliationCycle({
        prisma,
        pub,
        eventsChannel: "events:order:status",
        balancesChannel: "events:account:balances",
        now: new Date("2026-05-16T00:01:00.000Z"),
        staleMs: 10000,
        loadActiveExchangeCredential: async () => ({ apiKey: "api-key", secretKey: "secret-key" }),
        fetchOrder: async () => ({
            orderId: 98765,
            clientOrderId: "order_123",
            status: "FILLED",
            executedQty: "0.001",
            cummulativeQuoteQty: "65.00",
            updateTime: Date.parse("2026-05-16T00:00:30.000Z"),
        }),
        fetchMyTrades: async () => ([{
            id: 1,
            orderId: 98765,
            qty: "0.001",
            price: "65000",
            time: Date.parse("2026-05-16T00:00:30.000Z"),
        }]),
        fetchAccount: async () => ({
            balances: [
                { asset: "BTC", free: "0.001", locked: "0" },
                { asset: "USDT", free: "935.00", locked: "65.00" },
            ],
        }),
        logger: noopLogger(),
    });

    const updated = prisma.commands.get("order_123");
    assert.deepEqual(summary, {
        ordersChecked: 1,
        ordersUpdated: 1,
        orderEventsCreated: 1,
        accountsPublished: 1,
        errors: 0,
    });
    assert.equal(updated.status, "FILLED");
    assert.equal(updated.rawStatus, "FILLED");
    assert.equal(updated.binanceOrderId, 98765);
    assert.equal(updated.executedQty, "0.001");
    assert.equal(updated.cummulativeQuoteQty, "65");
    assert.equal(updated.avgFillPrice, "65000");
    assert.equal(updated.lastTradeQty, "0.001");
    assert.equal(updated.lastTradePrice, "65000");
    assert.equal(prisma.events[0].status, "FILLED");
    assert.equal(prisma.events[0].price, "65000");
    assert.equal(prisma.events[0].quantity, "0.001");
    assert.equal(pub.messages[0].channel, "events:order:status");
    assert.equal(pub.messages[0].message.userId, "user_123");
    assert.equal(pub.messages[0].message.source, "reconciliation");
    assert.equal(pub.messages[1].channel, "events:account:balances");
    assert.deepEqual(pub.messages[1].message.balances, [
        { asset: "BTC", free: "0.001", locked: "0" },
        { asset: "USDT", free: "935", locked: "65" },
    ]);
    assert.doesNotMatch(JSON.stringify(pub.messages), /api-key|secret-key|signature|token/i);
});

test("skips unchanged Binance order without duplicate events", async () => {
    const prisma = createMemoryPrisma([{
        orderId: "order_unchanged",
        userId: "user_123",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "LIMIT",
        quantity: "0.001",
        status: "SUBMITTED",
        rawStatus: "NEW",
        binanceOrderId: 98765,
        executedQty: "0",
        cummulativeQuoteQty: "0",
        updatedAt: new Date("2026-05-16T00:00:00.000Z"),
    }]);
    const pub = createPub();

    const summary = await runReconciliationCycle({
        prisma,
        pub,
        eventsChannel: "events:order:status",
        balancesChannel: "events:account:balances",
        now: new Date("2026-05-16T00:01:00.000Z"),
        staleMs: 10000,
        loadActiveExchangeCredential: async () => ({ apiKey: "api-key", secretKey: "secret-key" }),
        fetchOrder: async () => ({
            orderId: 98765,
            clientOrderId: "order_unchanged",
            status: "NEW",
            executedQty: "0",
            cummulativeQuoteQty: "0",
            updateTime: Date.parse("2026-05-16T00:00:30.000Z"),
        }),
        fetchAccount: async () => ({ balances: [] }),
        logger: noopLogger(),
    });

    assert.equal(summary.ordersChecked, 1);
    assert.equal(summary.ordersUpdated, 0);
    assert.equal(summary.orderEventsCreated, 0);
    assert.equal(prisma.events.length, 0);
    assert.equal(pub.messages.length, 1);
    assert.equal(pub.messages[0].message.type, "ACCOUNT_BALANCES");
});

test("normalizes account balances with Decimal-safe totals", () => {
    assert.deepEqual(normalizeAccountBalances([
        { asset: "btc", free: "0.100000000000000001", locked: "0.200000000000000002" },
    ]), [
        {
            asset: "BTC",
            free: "0.100000000000000001",
            locked: "0.200000000000000002",
            total: "0.300000000000000003",
        },
    ]);
});
