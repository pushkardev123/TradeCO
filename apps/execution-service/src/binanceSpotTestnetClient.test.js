import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";

import {
    BinanceApiError,
    createBinanceSpotTestnetClient,
    getBinanceResponseMetadata,
} from "./binanceSpotTestnetClient.js";

const FIXED_TS = 1700000000000;

function createMockTransport(responses = [{ statusCode: 200, headers: {}, body: "{}" }]) {
    const calls = [];
    let responseIndex = 0;

    return {
        calls,
        transport: async (request) => {
            calls.push(request);
            const response = responses[Math.min(responseIndex, responses.length - 1)];
            responseIndex += 1;
            return response;
        },
    };
}

function hmac(query, secret = "secret-key") {
    return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

test("signs GET requests with timestamp, recvWindow, HMAC, API key header, and rate-limit metadata", async () => {
    const { calls, transport } = createMockTransport([{
        statusCode: 200,
        headers: {
            "x-mbx-used-weight-1m": "42",
            "X-MBX-ORDER-COUNT-10S": "3",
        },
        body: JSON.stringify({ ok: true }),
    }]);
    const client = createBinanceSpotTestnetClient({
        timestamp: () => FIXED_TS,
        recvWindow: 6000,
        transport,
    });

    const result = await client.signedGet({
        path: "/api/v3/account",
        apiKey: "api-key",
        secretKey: "secret-key",
        params: { symbol: "BTCUSDT" },
    });

    const signingQuery = "symbol=BTCUSDT&timestamp=1700000000000&recvWindow=6000";
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers["X-MBX-APIKEY"], "api-key");
    assert.equal(calls[0].body, undefined);
    assert.equal(
        calls[0].url,
        `https://testnet.binance.vision/api/v3/account?${signingQuery}&signature=${hmac(signingQuery)}`,
    );
    assert.deepEqual(result.data, { ok: true });
    assert.deepEqual(result.metadata, {
        statusCode: 200,
        rateLimits: {
            "x-mbx-used-weight-1m": "42",
            "x-mbx-order-count-10s": "3",
        },
    });
    assert.deepEqual(getBinanceResponseMetadata(result.data), result.metadata);
});

test("normalizes Binance error responses without exposing request secrets or signatures", async () => {
    const { transport } = createMockTransport([{
        statusCode: 400,
        headers: { "x-mbx-used-weight": "9" },
        body: JSON.stringify({
            code: -2015,
            msg: "Rejected key super-api-key at https://example.test/path?signature=abcdef0123456789",
            signature: "abcdef0123456789",
            nested: { apiKey: "super-api-key" },
        }),
    }]);
    const client = createBinanceSpotTestnetClient({
        timestamp: () => FIXED_TS,
        transport,
    });

    let error;
    try {
        await client.signedGet({
            path: "/api/v3/account",
            apiKey: "super-api-key",
            secretKey: "secret-key",
        });
    } catch (caught) {
        error = caught;
    }

    assert.ok(error instanceof BinanceApiError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, -2015);
    assert.deepEqual(error.metadata.rateLimits, { "x-mbx-used-weight": "9" });
    const serialized = JSON.stringify({
        message: error.message,
        body: error.body,
        metadata: error.metadata,
    });
    assert.doesNotMatch(serialized, /super-api-key|abcdef0123456789|signature=abcdef/);
    assert.equal(error.body.signature, "<redacted>");
    assert.equal(error.body.nested.apiKey, "<redacted>");
});

test("enforces Binance Spot Testnet HTTPS REST base URL", () => {
    assert.equal(
        createBinanceSpotTestnetClient().baseUrl,
        "https://testnet.binance.vision",
    );
    assert.throws(
        () => createBinanceSpotTestnetClient({ baseUrl: "https://api.binance.com" }),
        /Spot Testnet/,
    );
    assert.throws(
        () => createBinanceSpotTestnetClient({ baseUrl: "http://testnet.binance.vision" }),
        /https/,
    );
});

test("constructs signed LIMIT order POST requests without a request body", async () => {
    const { calls, transport } = createMockTransport([{
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ orderId: 98765, status: "NEW" }),
    }]);
    const client = createBinanceSpotTestnetClient({
        timestamp: () => FIXED_TS,
        transport,
    });

    const response = await client.placeOrder({
        apiKey: "api-key",
        secretKey: "secret-key",
        symbol: "btcusdt",
        side: "buy",
        orderType: "limit",
        quantity: "0.001",
        price: "65000.25",
        timeInForce: "gtc",
        clientOrderId: "order_123",
    });

    const signingQuery = "symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=0.001&newClientOrderId=order_123&price=65000.25&timeInForce=GTC&timestamp=1700000000000&recvWindow=5000";
    assert.deepEqual(response, { orderId: 98765, status: "NEW" });
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[0].headers["X-MBX-APIKEY"], "api-key");
    assert.equal(
        calls[0].url,
        `https://testnet.binance.vision/api/v3/order?${signingQuery}&signature=${hmac(signingQuery)}`,
    );
});

test("constructs signed cancel and cancel-all DELETE requests", async () => {
    const { calls, transport } = createMockTransport([
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({ orderId: 98765, status: "CANCELED" }),
        },
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify([]),
        },
    ]);
    const client = createBinanceSpotTestnetClient({
        timestamp: () => FIXED_TS,
        transport,
    });

    await client.cancelOrder({
        apiKey: "api-key",
        secretKey: "secret-key",
        symbol: "ethusdt",
        orderId: "local_order_123",
        binanceOrderId: 98765,
    });
    await client.cancelAllOpenOrders({
        apiKey: "api-key",
        secretKey: "secret-key",
        symbol: "btcusdt",
    });

    const cancelQuery = "symbol=ETHUSDT&orderId=98765&timestamp=1700000000000&recvWindow=5000";
    assert.equal(calls[0].method, "DELETE");
    assert.equal(
        calls[0].url,
        `https://testnet.binance.vision/api/v3/order?${cancelQuery}&signature=${hmac(cancelQuery)}`,
    );

    const cancelAllQuery = "symbol=BTCUSDT&timestamp=1700000000000&recvWindow=5000";
    assert.equal(calls[1].method, "DELETE");
    assert.equal(
        calls[1].url,
        `https://testnet.binance.vision/api/v3/openOrders?${cancelAllQuery}&signature=${hmac(cancelAllQuery)}`,
    );
});

test("constructs signed order reconciliation read requests", async () => {
    const { calls, transport } = createMockTransport([
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({ orderId: 98765, status: "FILLED" }),
        },
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify([{ id: 1, orderId: 98765, qty: "0.001", price: "65000" }]),
        },
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify([{ orderId: 98765 }]),
        },
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify([]),
        },
    ]);
    const client = createBinanceSpotTestnetClient({
        timestamp: () => FIXED_TS,
        transport,
    });

    await client.getOrder({
        apiKey: "api-key",
        secretKey: "secret-key",
        symbol: "btcusdt",
        orderId: "local_order_123",
        binanceOrderId: 98765,
    });
    await client.getMyTrades({
        apiKey: "api-key",
        secretKey: "secret-key",
        symbol: "btcusdt",
        orderId: 98765,
        limit: 1000,
    });
    await client.getAllOrders({
        apiKey: "api-key",
        secretKey: "secret-key",
        symbol: "btcusdt",
        limit: 1000,
    });
    await client.getOpenOrders({
        apiKey: "api-key",
        secretKey: "secret-key",
        symbol: "ethusdt",
    });

    const orderQuery = "symbol=BTCUSDT&orderId=98765&timestamp=1700000000000&recvWindow=5000";
    assert.equal(calls[0].method, "GET");
    assert.equal(
        calls[0].url,
        `https://testnet.binance.vision/api/v3/order?${orderQuery}&signature=${hmac(orderQuery)}`,
    );

    const tradesQuery = "symbol=BTCUSDT&limit=1000&orderId=98765&timestamp=1700000000000&recvWindow=5000";
    assert.equal(
        calls[1].url,
        `https://testnet.binance.vision/api/v3/myTrades?${tradesQuery}&signature=${hmac(tradesQuery)}`,
    );

    const allOrdersQuery = "symbol=BTCUSDT&limit=1000&timestamp=1700000000000&recvWindow=5000";
    assert.equal(
        calls[2].url,
        `https://testnet.binance.vision/api/v3/allOrders?${allOrdersQuery}&signature=${hmac(allOrdersQuery)}`,
    );

    const openOrdersQuery = "symbol=ETHUSDT&timestamp=1700000000000&recvWindow=5000";
    assert.equal(
        calls[3].url,
        `https://testnet.binance.vision/api/v3/openOrders?${openOrdersQuery}&signature=${hmac(openOrdersQuery)}`,
    );
});

test("fetches symbol filters and average price from public testnet endpoints", async () => {
    const { calls, transport } = createMockTransport([
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({
                symbols: [{
                    symbol: "BTCUSDT",
                    baseAsset: "BTC",
                    quoteAsset: "USDT",
                    filters: [
                        { filterType: "LOT_SIZE", minQty: "0.00010000", maxQty: "100.00000000", stepSize: "0.00010000" },
                        { filterType: "PRICE_FILTER", minPrice: "0.01000000", maxPrice: "1000000.00000000", tickSize: "0.01000000" },
                        { filterType: "MIN_NOTIONAL", minNotional: "5.00000000", applyToMarket: true, avgPriceMins: 5 },
                    ],
                }],
            }),
        },
        {
            statusCode: 200,
            headers: {},
            body: JSON.stringify({ mins: 5, price: "65000.25", closeTime: 1700000000000 }),
        },
    ]);
    const client = createBinanceSpotTestnetClient({ transport });

    const symbolInfo = await client.fetchSymbolInfo({ symbol: "btcusdt" });
    const averagePrice = await client.fetchAveragePrice({ symbol: "btcusdt" });

    assert.equal(calls[0].url, "https://testnet.binance.vision/api/v3/exchangeInfo?symbol=BTCUSDT");
    assert.equal(calls[1].url, "https://testnet.binance.vision/api/v3/avgPrice?symbol=BTCUSDT");
    assert.equal(symbolInfo.symbol, "BTCUSDT");
    assert.equal(symbolInfo.filters.length, 3);
    assert.equal(symbolInfo.minQty, "0.00010000");
    assert.equal(averagePrice.price, "65000.25");
});
