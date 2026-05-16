import assert from "node:assert/strict";
import test from "node:test";

import {
    formatExchangeFilterErrors,
    normalizeBinanceSymbolFilters,
    validateOrderAgainstExchangeFilters,
} from "./binanceFilterValidation.js";

const BTCUSDT = Object.freeze({
    symbol: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.01000000", maxPrice: "1000000.00000000", tickSize: "0.01000000" },
        { filterType: "LOT_SIZE", minQty: "0.00010000", maxQty: "100.00000000", stepSize: "0.00010000" },
        { filterType: "MARKET_LOT_SIZE", minQty: "0.00100000", maxQty: "120.00000000", stepSize: "0.00100000" },
        { filterType: "MIN_NOTIONAL", minNotional: "5.00000000", applyToMarket: true, avgPriceMins: 5 },
        { filterType: "NOTIONAL", minNotional: "5.00000000", maxNotional: "100000.00000000", applyMinToMarket: true, applyMaxToMarket: false },
        { filterType: "MAX_NUM_ORDERS", maxNumOrders: 2 },
        { filterType: "MAX_NUM_ALGO_ORDERS", maxNumAlgoOrders: 1 },
        { filterType: "MAX_POSITION", maxPosition: "2.00000000" },
    ],
});

test("normalizes Binance exchangeInfo filters without float math", () => {
    const filters = normalizeBinanceSymbolFilters(BTCUSDT);

    assert.equal(filters.symbol, "BTCUSDT");
    assert.equal(filters.priceFilter.tickSize, "0.01");
    assert.equal(filters.lotSize.stepSize, "0.0001");
    assert.equal(filters.marketLotSize.minQty, "0.001");
    assert.equal(filters.minNotional.minNotional, "5");
    assert.equal(filters.notional.maxNotional, "100000");
    assert.equal(filters.maxPosition.maxPosition, "2");
});

test("accepts orders that align to price, quantity, and notional filters", () => {
    const result = validateOrderAgainstExchangeFilters({
        symbol: "btcusdt",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "0.0012",
        price: "65000.25",
    }, BTCUSDT);

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
});

test("returns field-level errors for LOT_SIZE, PRICE_FILTER, and MIN_NOTIONAL failures", () => {
    const result = validateOrderAgainstExchangeFilters({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "0.00015",
        price: "65000.251",
    }, BTCUSDT);

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => [error.field, error.code]), [
        ["quantity", "LOT_SIZE_STEP"],
        ["price", "PRICE_FILTER_TICK"],
    ]);
    assert.match(formatExchangeFilterErrors(result.errors), /quantity must align/);
});

test("uses MARKET_LOT_SIZE and average price for market order notional checks", () => {
    const result = validateOrderAgainstExchangeFilters({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quantity: "0.0005",
    }, BTCUSDT, { averagePrice: "1000" });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => [error.field, error.code]), [
        ["quantity", "MARKET_LOT_SIZE_MIN"],
        ["quantity", "MARKET_LOT_SIZE_STEP"],
        ["notional", "MIN_NOTIONAL_MIN"],
        ["notional", "NOTIONAL_MIN"],
    ]);
});

test("validates MARKET quoteOrderQty as notional without LOT_SIZE checks", () => {
    const accepted = validateOrderAgainstExchangeFilters({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quoteOrderQty: "25",
    }, BTCUSDT);

    assert.equal(accepted.ok, true);

    const rejected = validateOrderAgainstExchangeFilters({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quoteOrderQty: "1",
    }, BTCUSDT);

    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.errors.map((error) => [error.field, error.code]), [
        ["notional", "MIN_NOTIONAL_MIN"],
        ["notional", "NOTIONAL_MIN"],
    ]);
});

test("rejects quoteOrderQty for non-market orders", () => {
    const result = validateOrderAgainstExchangeFilters({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "0.01",
        quoteOrderQty: "25",
        price: "65000.25",
    }, BTCUSDT);

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => [error.field, error.code]), [
        ["quoteOrderQty", "QUOTE_ORDER_QTY_EXCLUSIVE"],
        ["quoteOrderQty", "QUOTE_ORDER_QTY_UNSUPPORTED"],
    ]);
});

test("supports optional max order and max position context", () => {
    const result = validateOrderAgainstExchangeFilters({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "0.6",
        price: "100",
    }, BTCUSDT, {
        openOrderCount: 2,
        openAlgoOrderCount: 1,
        baseAssetPositionQuantity: "1.5",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => [error.field, error.code]), [
        ["symbol", "MAX_NUM_ORDERS"],
        ["symbol", "MAX_NUM_ALGO_ORDERS"],
        ["quantity", "MAX_POSITION"],
    ]);
});
