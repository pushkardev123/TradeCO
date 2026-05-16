import test from "node:test";
import assert from "node:assert/strict";

import {
    API_CONTRACT_VERSION,
    ADVANCED_ORDER_TYPES,
    BASIC_ORDER_TYPES,
    DEFAULT_REALTIME_CHANNELS,
    OPEN_ORDER_STATUSES,
    assertContract,
    formatOrderCommandDto,
    formatPositionDto,
    validateAccountBalancesPayload,
    validateOrderDto,
    validateOrdersPageResponse,
    validatePositionsPageResponse,
} from "./index.js";

test("exports stable API and realtime contract constants", () => {
    assert.equal(API_CONTRACT_VERSION, "1");
    assert.deepEqual(BASIC_ORDER_TYPES, ["LIMIT", "MARKET", "STOP_LOSS"]);
    assert.ok(ADVANCED_ORDER_TYPES.includes("TAKE_PROFIT_LIMIT"));
    assert.equal(DEFAULT_REALTIME_CHANNELS.orders, "events:order:status");
    assert.ok(OPEN_ORDER_STATUSES.includes("PARTIALLY_FILLED"));
});

test("formats order commands into API-safe decimal and timestamp strings", () => {
    const createdAt = new Date("2026-05-16T00:00:00.000Z");
    const dto = formatOrderCommandDto(
        {
            orderId: "order_1",
            symbol: "BTCUSDT",
            side: "BUY",
            type: "LIMIT",
            quantity: { toString: () => "0.001" },
            price: "65000.25",
            stopPrice: null,
            status: "SUBMITTED",
            executedQty: "0",
            cummulativeQuoteQty: "0",
            avgFillPrice: null,
            lastTradeQty: null,
            lastTradePrice: null,
            binanceOrderId: 123,
            createdAt,
            updatedAt: createdAt,
        },
        { status: "PARTIALLY_FILLED", timestamp: createdAt },
    );

    assert.equal(dto.orderType, "LIMIT");
    assert.equal(dto.quantity, "0.001");
    assert.equal(dto.quoteOrderQty, null);
    assert.equal(dto.binanceOrderId, "123");
    assert.equal(dto.timestamp, "2026-05-16T00:00:00.000Z");
    assert.deepEqual(validateOrderDto(dto), []);
});

test("validates paginated order and position response shapes", () => {
    const order = formatOrderCommandDto({
        orderId: "order_1",
        symbol: "BTCUSDT",
        side: "BUY",
        type: "MARKET",
        quantity: "0.001",
        status: "FILLED",
    });
    const position = formatPositionDto({
        id: "position_1",
        symbol: "BTCUSDT",
        quantity: "0.001",
        avgPrice: "65000",
        realizedPnl: "0",
    });

    assert.deepEqual(validateOrdersPageResponse({ ok: true, items: [order], nextCursor: null, totalEntries: 1, totalPages: 1 }), []);
    assert.deepEqual(validatePositionsPageResponse({ ok: true, items: [position], nextCursor: null, totalEntries: 1, totalPages: 1 }), []);
});

test("validates account balance payloads", () => {
    assert.deepEqual(validateAccountBalancesPayload({
        balances: [
            { asset: "BTC", free: "0.001", locked: "0" },
            { asset: "USDT", free: "100", locked: "1.25" },
        ],
    }), []);

    assert.throws(
        () => assertContract("balances", { balances: [{ asset: "", free: 0, locked: "0" }] }, validateAccountBalancesPayload),
        /balances contract failed/,
    );
});
