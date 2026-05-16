import assert from "node:assert/strict";
import test from "node:test";
import {
    createLogger,
    createRequestContext,
    redactUrl,
    safeError,
    sanitizeLogFields,
} from "./index.js";

test("creates JSON log entries with service context", () => {
    const lines = [];
    const logger = createLogger({
        service: "backend",
        context: { instance: "test" },
        sink: (line) => lines.push(JSON.parse(line)),
    });

    logger.info("order.created", { orderId: "order_1" });

    assert.equal(lines.length, 1);
    assert.equal(lines[0].service, "backend");
    assert.equal(lines[0].msg, "order.created");
    assert.equal(lines[0].instance, "test");
    assert.equal(lines[0].orderId, "order_1");
    assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("redacts sensitive keys, bearer tokens, JWTs, and signatures", () => {
    const sanitized = sanitizeLogFields({
        authorization: "Bearer secret",
        binanceApiKey: "abc",
        nested: {
            refreshToken: "refresh",
            url: "https://testnet.binance.vision/api/v3/order?symbol=BTCUSDT&signature=abcdef",
            value: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
        },
    });

    assert.equal(sanitized.authorization, "[redacted]");
    assert.equal(sanitized.binanceApiKey, "[redacted]");
    assert.equal(sanitized.nested.refreshToken, "[redacted]");
    assert.match(sanitized.nested.url, /signature=\[redacted\]/);
    assert.doesNotMatch(sanitized.nested.value, /eyJ/);
});

test("derives request and trace ids from headers", () => {
    assert.deepEqual(
        createRequestContext({ "x-request-id": "req_1", "x-trace-id": "trace_1" }),
        { requestId: "req_1", traceId: "trace_1" },
    );

    const generated = createRequestContext({});
    assert.ok(generated.requestId);
    assert.equal(generated.traceId, generated.requestId);
});

test("safeError and redactUrl avoid credential leakage", () => {
    const error = Object.assign(new Error("failed with token eyJhbGci.eyJzdWI.sig"), {
        code: "ERR",
        statusCode: 500,
    });

    assert.deepEqual(safeError(error), {
        name: "Error",
        code: "ERR",
        message: "failed with token [redacted-jwt]",
        statusCode: 500,
    });
    assert.equal(redactUrl("postgresql://user:pass@localhost:5432/db?schema=public"), "postgresql://<redacted>@localhost:5432/db");
});
