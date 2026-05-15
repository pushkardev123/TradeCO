import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";

import {
    BINANCE_SPOT_TESTNET_WS_API_BASE,
    buildUserDataStreamSubscribeRequest,
    buildUserDataStreamUnsubscribeRequest,
    getUserDataStreamSubscriptionId,
    isUserDataStreamSubscribeAck,
    normalizeBinanceWsApiBase,
    parseUserDataStreamMessage,
    serializeWebSocketApiSigningPayload,
    signWebSocketApiParams,
} from "./binanceUserDataStream.js";

const FIXED_TS = 1700000000000;

function hmac(payload, secret = "secret-key") {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

test("normalizes the Binance Spot Testnet WebSocket API base", () => {
    assert.equal(normalizeBinanceWsApiBase(), BINANCE_SPOT_TESTNET_WS_API_BASE);
    assert.equal(
        normalizeBinanceWsApiBase("wss://ws-api.testnet.binance.vision/ws-api/v3/"),
        BINANCE_SPOT_TESTNET_WS_API_BASE,
    );
    assert.throws(
        () => normalizeBinanceWsApiBase("wss://stream.testnet.binance.vision/ws-api/v3"),
        /WebSocket API/,
    );
    assert.throws(
        () => normalizeBinanceWsApiBase("https://ws-api.testnet.binance.vision/ws-api/v3"),
        /wss/,
    );
});

test("builds signed WebSocket API user data stream subscribe requests", () => {
    const request = buildUserDataStreamSubscribeRequest({
        apiKey: "api-key",
        secretKey: "secret-key",
        timestamp: FIXED_TS,
        recvWindow: 6000,
        id: "fixed-id",
    });

    const signingPayload = "apiKey=api-key&recvWindow=6000&timestamp=1700000000000";
    assert.deepEqual(request, {
        id: "fixed-id",
        method: "userDataStream.subscribe.signature",
        params: {
            apiKey: "api-key",
            timestamp: FIXED_TS,
            recvWindow: 6000,
            signature: hmac(signingPayload),
        },
    });
    assert.equal(serializeWebSocketApiSigningPayload(request.params), signingPayload);
    assert.equal(signWebSocketApiParams(request.params, "secret-key"), hmac(signingPayload));
});

test("builds WebSocket API user data stream unsubscribe requests", () => {
    assert.deepEqual(buildUserDataStreamUnsubscribeRequest({ subscriptionId: 7, id: "stop-1" }), {
        id: "stop-1",
        method: "userDataStream.unsubscribe",
        params: { subscriptionId: 7 },
    });
});

test("parses WebSocket API wrapped user data events and subscription acknowledgements", () => {
    const event = parseUserDataStreamMessage(JSON.stringify({
        subscriptionId: 0,
        event: { e: "executionReport", s: "BTCUSDT" },
    }));

    assert.equal(event.kind, "event");
    assert.equal(event.subscriptionId, 0);
    assert.deepEqual(event.event, { e: "executionReport", s: "BTCUSDT" });

    const ack = parseUserDataStreamMessage(JSON.stringify({
        id: "fixed-id",
        status: 200,
        result: { subscriptionId: 12 },
    }));

    assert.equal(ack.kind, "response");
    assert.equal(isUserDataStreamSubscribeAck(ack, "fixed-id"), true);
    assert.equal(getUserDataStreamSubscriptionId(ack), 12);
});
