import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = "test-jwt-secret-for-binance-filters";
process.env.ENCRYPTION_KEY = "12345678901234567890123456789012";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/tradeco_test";
process.env.REDIS_URL = "redis://localhost:6379";

const { createBinanceFilterValidator } = await import("./binanceExchangeFilters.js");

const SYMBOL_INFO = {
    symbol: "BTCUSDT",
    filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.01000000", maxPrice: "1000000.00000000", tickSize: "0.01000000" },
        { filterType: "LOT_SIZE", minQty: "0.00010000", maxQty: "100.00000000", stepSize: "0.00010000" },
        { filterType: "MARKET_LOT_SIZE", minQty: "0.00100000", maxQty: "100.00000000", stepSize: "0.00100000" },
        { filterType: "MIN_NOTIONAL", minNotional: "5.00000000", applyToMarket: true, avgPriceMins: 5 },
    ],
};

function createMockFetch() {
    const calls = [];
    const fetchImpl = async (url) => {
        const parsed = new URL(String(url));
        calls.push(parsed);
        if (parsed.pathname.endsWith("/exchangeInfo")) {
            return {
                ok: true,
                async json() {
                    return { symbols: [SYMBOL_INFO] };
                },
            };
        }

        if (parsed.pathname.endsWith("/avgPrice")) {
            return {
                ok: true,
                async json() {
                    return { mins: 5, price: "1000.00" };
                },
            };
        }

        return {
            ok: false,
            async json() {
                return { msg: "not found" };
            },
        };
    };
    return { calls, fetchImpl };
}

test("validates limit orders using cached exchangeInfo filters", async () => {
    const { calls, fetchImpl } = createMockFetch();
    const validator = createBinanceFilterValidator({ fetchImpl, baseUrl: "https://testnet.binance.vision" });

    const result = await validator.validateOrderDraft({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "0.001",
        price: "65000.25",
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/api/v3/exchangeInfo");
});

test("returns field-level Binance filter errors before stream append", async () => {
    const { fetchImpl } = createMockFetch();
    const validator = createBinanceFilterValidator({ fetchImpl, baseUrl: "https://testnet.binance.vision" });

    const result = await validator.validateOrderDraft({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "LIMIT",
        quantity: "0.00015",
        price: "65000.251",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => [error.field, error.code]), [
        ["quantity", "LOT_SIZE_STEP"],
        ["price", "PRICE_FILTER_TICK"],
    ]);
});

test("uses average price for market order notional validation", async () => {
    const { calls, fetchImpl } = createMockFetch();
    const validator = createBinanceFilterValidator({ fetchImpl, baseUrl: "https://testnet.binance.vision" });

    const result = await validator.validateOrderDraft({
        symbol: "BTCUSDT",
        side: "BUY",
        orderType: "MARKET",
        quantity: "0.001",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((error) => [error.field, error.code]), [
        ["notional", "MIN_NOTIONAL_MIN"],
    ]);
    assert.equal(calls.map((url) => url.pathname).includes("/api/v3/avgPrice"), true);
});
