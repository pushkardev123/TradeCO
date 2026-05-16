import http from "http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { createClient } from "redis";
import {
    createLogger,
    createRequestContext,
    durationMs,
    safeError as toSafeError,
    setTraceHeaders,
} from "@tradeco/observability";
import { getRealtimeChannelConfig } from "@tradeco/redis-stream-contracts";
import { config, getCorsAllowOrigin, logStartupConfig, redactUrl } from "./config.js";
import {
    canReceiveBroadcast,
    getBearerToken,
    getUserIdParam,
    hasUserIdParam,
    shouldBroadcastChannelMessage,
    verifyAccessToken,
} from "./auth.js";
import {
    createRedisWebSocketEnvelope,
    validateBroadcastMessage,
} from "./broadcastContracts.js";

const PORT = config.port;
const REDIS_URL = config.redisUrl;
const BINANCE_API_BASE = config.binanceApiBase;
const EVENTS_CHANNEL = config.eventsChannel;
const ORDERS_CHANNEL = config.ordersChannel;
const PRICES_CHANNEL = config.pricesChannel;

const BALANCES_CHANNEL = config.balancesChannel;
const JWT_SECRET = config.jwtSecret;

// Charts (candlesticks / klines)
const CHART_REQ_CHANNEL = config.chartReqChannel;
const CHARTS_CHANNEL = config.chartsChannel;
const MARKET_REQ_CHANNEL = config.marketReqChannel;
const MARKET_DETAIL_CHANNEL = config.marketDetailChannel;

// Account info RPC (event-service -> execution-service)
const ACCOUNT_REQ_CHANNEL = config.accountReqChannel;
const ACCOUNT_RES_CHANNEL = config.accountResChannel;
const ACCOUNT_CACHE_MS = config.accountCacheMs;

// Symbol metadata (exchange filters like LOT_SIZE / stepSize / minQty)
const SYMBOL_REQ_CHANNEL = config.symbolReqChannel;
const SYMBOL_RES_CHANNEL = config.symbolResChannel;
const SYMBOL_CACHE_MS = config.symbolCacheMs;
const REALTIME_CHANNELS = getRealtimeChannelConfig(process.env);
const logger = createLogger({ service: "event-service" });

let redisPub = null;

// Pending RPC-style requests waiting for execution-service responses
const pending = new Map(); // id -> { resolve, reject, timeout }

// In-memory cache for account snapshot per user
const accountCache = new Map(); // userId -> { ts, data }

function accountCacheGet(userId) {
    const key = String(userId || "");
    const entry = accountCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > ACCOUNT_CACHE_MS) {
        accountCache.delete(key);
        return null;
    }
    return entry.data;
}

function accountCacheSet(userId, data) {
    const key = String(userId || "");
    accountCache.set(key, { ts: Date.now(), data });
}


async function requestAccountInfo({ userId, pinnedAssets = [], timeoutMs = 8000 }) {
    const uid = String(userId || "");
    if (!uid) throw new Error("userId is required");

    const cached = accountCacheGet(uid);
    if (cached) return { fromCache: true, data: cached };

    if (!redisPub) throw new Error("redis publisher not ready");

    const id = `acct-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const req = {
        type: "ACCOUNT_INFO_REQUEST",
        id,
        userId: uid,
        pinnedAssets,
        replyTo: ACCOUNT_RES_CHANNEL,
        ts: Date.now(),
    };

    const p = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error("account info timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
    });

    await redisPub.publish(ACCOUNT_REQ_CHANNEL, JSON.stringify(req));
    const data = await p;
    accountCacheSet(uid, data);
    return { fromCache: false, data };
}

// In-memory cache: SYMBOL -> { data, ts }
const symbolCache = new Map();

function cacheGet(symbol) {
    const key = String(symbol || "").toUpperCase();
    const entry = symbolCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > SYMBOL_CACHE_MS) {
        symbolCache.delete(key);
        return null;
    }
    return entry.data;
}

function cacheSet(symbol, data) {
    const key = String(symbol || "").toUpperCase();
    symbolCache.set(key, { data, ts: Date.now() });
}

async function requestSymbolInfo(symbol, timeoutMs = 6000) {
    const sym = String(symbol || "").toUpperCase();

    const cached = cacheGet(sym);
    if (cached) return { fromCache: true, data: cached };

    if (!redisPub) throw new Error("redis publisher not ready");

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const req = {
        type: "SYMBOL_INFO_REQUEST",
        id,
        symbol: sym,
        replyTo: SYMBOL_RES_CHANNEL,
        ts: Date.now(),
    };

    const p = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error("symbol info timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
    });

    await redisPub.publish(SYMBOL_REQ_CHANNEL, JSON.stringify(req));
    const data = await p;
    cacheSet(sym, data);
    return { fromCache: false, data };
}


function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(body));
}

function requestLogContext(req, fields = {}) {
    return {
        requestId: req.requestId,
        traceId: req.traceId,
        ...fields,
    };
}

function rejectUserIdParam(url, user, res) {
    const supplied = getUserIdParam(url);
    if (supplied === null) return false;

    const suppliedUserId = String(supplied || "");
    if (suppliedUserId && suppliedUserId !== user?.id) {
        sendJson(res, 403, { ok: false, error: "userId does not match the authenticated user" });
        return true;
    }

    sendJson(res, 403, {
        ok: false,
        error: "userId is derived from the access token and is not accepted in requests",
    });
    return true;
}

function requireHttpUser(req, res) {
    const token = getBearerToken(req);
    if (!token) {
        sendJson(res, 401, { ok: false, error: "Missing Bearer token" });
        return null;
    }

    try {
        return verifyAccessToken(token, JWT_SECRET);
    } catch (e) {
        const status = e?.statusCode || 401;
        sendJson(res, status, { ok: false, error: status === 503 ? "JWT_SECRET missing" : "Invalid/expired token" });
        return null;
    }
}

function setCors(req, res) {
    const origin = String(req.headers.origin || "");
    const allowOrigin = getCorsAllowOrigin(origin);
    if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader("Vary", "Origin");
        if (allowOrigin !== "*") {
            res.setHeader("Access-Control-Allow-Credentials", "true");
        }
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
            // simple guard (1MB)
            if (data.length > 1_000_000) {
                reject(new Error("Payload too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!data) return resolve(null);
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function normalizeChartSymbol(value) {
    const symbol = String(value || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return "";
    return symbol;
}

function normalizeChartInterval(value) {
    const interval = String(value || "1m").trim().toLowerCase();
    const allowed = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]);
    return allowed.has(interval) ? interval : "";
}

function normalizeChartLimit(value) {
    const limit = Number(value);
    if (!Number.isInteger(limit)) return 500;
    return Math.max(1, Math.min(limit, 1000));
}

async function fetchKlineSnapshot({ symbol, interval, limit }) {
    const url = new URL("/api/v3/klines", BINANCE_API_BASE);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url, { method: "GET" });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const message = data?.msg || data?.message || `Binance klines failed (${response.status})`;
        throw new Error(message);
    }
    if (!Array.isArray(data)) {
        throw new Error("Binance klines response was not an array");
    }

    const candles = data.map((kline) => {
        const startTime = Number(kline?.[0]);
        const open = Number(kline?.[1]);
        const high = Number(kline?.[2]);
        const low = Number(kline?.[3]);
        const close = Number(kline?.[4]);
        const volume = Number(kline?.[5]);
        const closeTime = Number(kline?.[6]);

        if (![startTime, closeTime, open, high, low, close].every(Number.isFinite)) return null;
        return {
            time: Math.floor(startTime / 1000),
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
            startTime,
            closeTime,
        };
    }).filter(Boolean);

    return { symbol, interval, candles };
}

// --- HTTP server (health + REST endpoints + WS upgrade) ---
const server = http.createServer(async (req, res) => {
    const context = createRequestContext(req.headers);
    req.requestId = context.requestId;
    req.traceId = context.traceId;
    setTraceHeaders(res, context);

    const startedAt = Date.now();
    res.on("finish", () => {
        const path = String(req.url || "").split("?")[0] || "/";
        logger.info("http.request", {
            requestId: req.requestId,
            traceId: req.traceId,
            method: req.method,
            path,
            statusCode: res.statusCode,
            durationMs: durationMs(startedAt),
        });
    });

    setCors(req, res);

    // Preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                ok: true,
                service: "event-service",
                requestId: req.requestId,
                redisUrl: redactUrl(REDIS_URL),
                eventsChannel: EVENTS_CHANNEL,
                ordersChannel: ORDERS_CHANNEL,
                pricesChannel: PRICES_CHANNEL,
                balancesChannel: BALANCES_CHANNEL,
                chartReqChannel: CHART_REQ_CHANNEL,
                chartsChannel: CHARTS_CHANNEL,
                marketReqChannel: MARKET_REQ_CHANNEL,
                marketDetailChannel: MARKET_DETAIL_CHANNEL,
                accountReqChannel: ACCOUNT_REQ_CHANNEL,
                accountResChannel: ACCOUNT_RES_CHANNEL,
                accountCacheMs: ACCOUNT_CACHE_MS,
                symbolReqChannel: SYMBOL_REQ_CHANNEL,
                symbolResChannel: SYMBOL_RES_CHANNEL,
                symbolCacheMs: SYMBOL_CACHE_MS,
                hasPublisher: Boolean(redisPub),
                redis: {
                    publisherReady: Boolean(redisPub?.isReady),
                },
                websocketClients: clients.size,
                pendingRequests: pending.size,
                cache: {
                    accountEntries: accountCache.size,
                    symbolEntries: symbolCache.size,
                },
                uptimeSec: Math.round(process.uptime()),
            })
        );
        return;
    }
    // Frontend -> event-service: fetch account balances (pinned + nonZero).
    // User scope comes from the verified access token; client userId is not accepted.
    if (req.url?.startsWith("/account-info") && req.method === "GET") {
        const user = requireHttpUser(req, res);
        if (!user) return;

        try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            if (rejectUserIdParam(u, user, res)) return;

            const pinnedParam = String(u.searchParams.get("pinned") || "");
            const pinnedAssets = pinnedParam
                ? pinnedParam.split(",").map((s) => s.trim()).filter(Boolean)
                : [];

            const out = await requestAccountInfo({ userId: user.id, pinnedAssets, timeoutMs: 8000 });
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, fromCache: out.fromCache, data: out.data }));
        } catch (e) {
            logger.error("account_info.error", requestLogContext(req, { error: toSafeError(e) }));
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: e?.message || "timeout" }));
        }
    }

    // Frontend -> event-service: fetch symbol filters (LOT_SIZE, PRICE_FILTER, NOTIONAL, etc)
    if (req.url?.startsWith("/symbol-info") && req.method === "GET") {
        try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            const symbol = String(u.searchParams.get("symbol") || "").toUpperCase();
            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol query param is required" }));
            }

            const cached = cacheGet(symbol);
            if (cached) {
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: true, symbol, fromCache: true, data: cached }));
            }

            const out = await requestSymbolInfo(symbol, 6000);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, symbol, fromCache: out.fromCache, data: out.data }));
        } catch (e) {
            logger.error("symbol_info.error", requestLogContext(req, { error: toSafeError(e) }));
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: e?.message || "timeout" }));
        }
    }

    if (req.url?.startsWith("/charts/snapshot") && req.method === "GET") {
        try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            const symbol = normalizeChartSymbol(u.searchParams.get("symbol") || "BTCUSDT");
            const interval = normalizeChartInterval(u.searchParams.get("interval") || "1m");
            const limit = normalizeChartLimit(u.searchParams.get("limit") || "500");

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "invalid symbol" }));
            }
            if (!interval) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "invalid interval" }));
            }

            const snapshot = await fetchKlineSnapshot({ symbol, interval, limit });
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                ok: true,
                ...snapshot,
                source: "REST",
                ts: Date.now(),
            }));
        } catch (e) {
            logger.error("chart.snapshot.error", requestLogContext(req, { error: toSafeError(e) }));
            res.writeHead(502, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: e?.message || "chart snapshot failed" }));
        }
    }

    // Frontend -> event-service: request chart stream (execution-service will connect to Binance WS)
    // Example: POST /charts/subscribe  { symbol: "BTCUSDT", interval: "1m" }
    if (req.url === "/charts/subscribe" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const symbol = String(body?.symbol || "").toUpperCase();
            const interval = String(body?.interval || "1m").toLowerCase();

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const id = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const msg = { type: "CHART_SUBSCRIBE", id, symbol, interval, ts: Date.now() };

            await redisPub.publish(CHART_REQ_CHANNEL, JSON.stringify(msg));
            logger.info("chart.subscribe.published", requestLogContext(req, {
                id,
                symbol,
                interval,
                channel: CHART_REQ_CHANNEL,
            }));

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: CHART_REQ_CHANNEL, request: msg }));
        } catch (e) {
            logger.error("chart.subscribe.error", requestLogContext(req, { error: toSafeError(e) }));
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    // Optional: unsubscribe
    // Example: POST /charts/unsubscribe { symbol: "BTCUSDT", interval: "1m" }
    if (req.url === "/charts/unsubscribe" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const symbol = String(body?.symbol || "").toUpperCase();
            const interval = String(body?.interval || "1m").toLowerCase();

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const id = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const msg = { type: "CHART_UNSUBSCRIBE", id, symbol, interval, ts: Date.now() };

            await redisPub.publish(CHART_REQ_CHANNEL, JSON.stringify(msg));
            logger.info("chart.unsubscribe.published", requestLogContext(req, {
                id,
                symbol,
                interval,
                channel: CHART_REQ_CHANNEL,
            }));

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: CHART_REQ_CHANNEL, request: msg }));
        } catch (e) {
            logger.error("chart.unsubscribe.error", requestLogContext(req, { error: toSafeError(e) }));
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    if (req.url === "/market/subscribe" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const symbol = String(body?.symbol || "").toUpperCase();

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const id = `market-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const msg = { type: "MARKET_DETAIL_SUBSCRIBE", id, symbol, ts: Date.now() };

            await redisPub.publish(MARKET_REQ_CHANNEL, JSON.stringify(msg));
            logger.info("market_detail.subscribe.published", requestLogContext(req, {
                id,
                symbol,
                channel: MARKET_REQ_CHANNEL,
            }));

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: MARKET_REQ_CHANNEL, request: msg }));
        } catch (e) {
            logger.error("market_detail.subscribe.error", requestLogContext(req, { error: toSafeError(e) }));
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    if (req.url === "/market/unsubscribe" && req.method === "POST") {
        try {
            const body = await readJson(req);
            const symbol = String(body?.symbol || "").toUpperCase();

            if (!symbol) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "symbol is required" }));
            }
            if (!redisPub) {
                res.writeHead(503, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: "redis publisher not ready" }));
            }

            const id = `market-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const msg = { type: "MARKET_DETAIL_UNSUBSCRIBE", id, symbol, ts: Date.now() };

            await redisPub.publish(MARKET_REQ_CHANNEL, JSON.stringify(msg));
            logger.info("market_detail.unsubscribe.published", requestLogContext(req, {
                id,
                symbol,
                channel: MARKET_REQ_CHANNEL,
            }));

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: MARKET_REQ_CHANNEL, request: msg }));
        } catch (e) {
            logger.error("market_detail.unsubscribe.error", requestLogContext(req, { error: toSafeError(e) }));
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
    }

    // Order submission belongs to the authenticated backend command gateway.
    // Do not accept client-supplied userId or order ingress in the realtime service.
    if (req.url === "/orders" && req.method === "POST") {
        return sendJson(res, 410, { ok: false, error: "Submit orders through the backend API" });
    }

    res.writeHead(404);
    res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

// Track live clients
const clients = new Set();

// Only accept authenticated WS upgrades on /prices. Market data can be public at the
// producer level, but this app websocket also carries scoped account/order updates.
server.on("upgrade", (req, socket, head) => {
    const context = createRequestContext(req.headers);
    req.requestId = context.requestId;
    req.traceId = context.traceId;

    const u = new URL(req.url || "/", `http://localhost:${PORT}`);
    if (u.pathname !== "/prices") return socket.destroy();

    const token = u.searchParams.get("token");
    if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
    }

    let user;
    try {
        user = verifyAccessToken(token, JWT_SECRET);
    } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
    }

    if (hasUserIdParam(u)) {
        const suppliedUserId = String(getUserIdParam(u) || "");
        if (suppliedUserId && suppliedUserId !== user.id) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            return socket.destroy();
        }

        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = user;
        ws.connectionId = randomUUID();
        ws.requestId = req.requestId || null;
        ws.traceId = req.traceId || ws.requestId;
        wss.emit("connection", ws, req);
    });
});

wss.on("connection", (ws) => {
    clients.add(ws);
    logger.info("ws.connected", {
        connectionId: ws.connectionId,
        requestId: ws.requestId,
        traceId: ws.traceId,
        userId: ws.user?.id,
        clientCount: clients.size,
    });

    ws.send(
        JSON.stringify({
            type: "HELLO",
            message: "connected to /prices",
            authenticated: Boolean(ws.user),
            note: "Broadcasting realtime updates for the verified access-token user",
            channels: {
                orders: EVENTS_CHANNEL,
                prices: PRICES_CHANNEL,
                balances: BALANCES_CHANNEL,
                chartsRequest: CHART_REQ_CHANNEL,
                charts: CHARTS_CHANNEL,
                marketRequest: MARKET_REQ_CHANNEL,
                marketDetails: MARKET_DETAIL_CHANNEL,
                symbolRequest: SYMBOL_REQ_CHANNEL,
                symbolResponse: SYMBOL_RES_CHANNEL,
            },
        })
    );

    ws.on("close", () => {
        clients.delete(ws);
        logger.info("ws.closed", {
            connectionId: ws.connectionId,
            userId: ws.user?.id,
            clientCount: clients.size,
        });
    });

    ws.on("error", (error) => {
        clients.delete(ws);
        logger.warn("ws.error", {
            connectionId: ws.connectionId,
            userId: ws.user?.id,
            error: toSafeError(error),
        });
    });
});

const SCOPED_CHANNELS = [REALTIME_CHANNELS.orders, REALTIME_CHANNELS.balances, REALTIME_CHANNELS.accountResponse];

function broadcast(channel, message) {
    const validation = validateBroadcastMessage({ channel, message, channels: REALTIME_CHANNELS });
    if (!validation.ok) {
        logger.warn("realtime.payload_rejected", {
            channel,
            errors: validation.errors,
        });
        return;
    }

    if (!shouldBroadcastChannelMessage({ channel, message, scopedChannels: SCOPED_CHANNELS })) return;

    const raw = createRedisWebSocketEnvelope({
        channel,
        message,
        channels: REALTIME_CHANNELS,
    });

    for (const ws of clients) {
        if (ws.readyState !== 1) {
            clients.delete(ws);
            continue;
        }

        if (!canReceiveBroadcast({ ws, channel, message, scopedChannels: SCOPED_CHANNELS })) continue;
        ws.send(raw);
    }
}

// --- Redis subscriber: channels -> WS broadcast ---
async function startRedisSubscriber() {
    const sub = createClient({ url: REDIS_URL });

    sub.on("error", (err) => {
        logger.error("redis.subscriber.error", { error: toSafeError(err) });
    });

    await sub.connect();
    logger.info("redis.subscriber.connected", { redisUrl: redactUrl(REDIS_URL) });

    const forward = (channel, message) => {
        broadcast(channel, message);
    };

    await sub.subscribe(EVENTS_CHANNEL, (message) => forward(EVENTS_CHANNEL, message));
    await sub.subscribe(PRICES_CHANNEL, (message) => forward(PRICES_CHANNEL, message));
    await sub.subscribe(CHARTS_CHANNEL, (message) => forward(CHARTS_CHANNEL, message));
    await sub.subscribe(MARKET_DETAIL_CHANNEL, (message) => forward(MARKET_DETAIL_CHANNEL, message));
    await sub.subscribe(BALANCES_CHANNEL, (message) => forward(BALANCES_CHANNEL, message));
    await sub.subscribe(SYMBOL_RES_CHANNEL, (message) => {
        try {
            const payload = JSON.parse(message);
            const id = payload?.id;
            if (id && pending.has(id)) {
                const p = pending.get(id);
                clearTimeout(p.timeout);
                pending.delete(id);
                if (payload?.ok === false) p.reject(new Error(payload?.error || "symbol info failed"));
                else p.resolve(payload?.data);
            }

            // Warm cache only if ok === true
            if (payload?.ok === true && payload?.symbol && payload?.data) {
                cacheSet(payload.symbol, payload.data);
            }
        } catch {
            // ignore
        }

        forward(SYMBOL_RES_CHANNEL, message);
    });
    await sub.subscribe(ACCOUNT_RES_CHANNEL, (message) => {
        try {
            const payload = JSON.parse(message);
            const id = payload?.id;
            if (id && pending.has(id)) {
                const p = pending.get(id);
                clearTimeout(p.timeout);
                pending.delete(id);
                if (payload?.ok === false) p.reject(new Error(payload?.error || "account info failed"));
                else p.resolve(payload?.data);
            }

            // Warm cache if ok
            if (payload?.ok === true && payload?.userId && payload?.data) {
                accountCacheSet(payload.userId, payload.data);
            }
        } catch {
            // ignore
        }

        forward(ACCOUNT_RES_CHANNEL, message);
    });

    logger.info("redis.subscriptions.ready", {
        channels: [
            EVENTS_CHANNEL,
            PRICES_CHANNEL,
            CHARTS_CHANNEL,
            MARKET_DETAIL_CHANNEL,
            SYMBOL_RES_CHANNEL,
            BALANCES_CHANNEL,
            ACCOUNT_RES_CHANNEL,
        ],
    });

    return sub;
}

// --- Boot ---
(async () => {
    logStartupConfig();

    redisPub = createClient({ url: REDIS_URL });
    redisPub.on("error", (err) => logger.error("redis.publisher.error", { error: toSafeError(err) }));
    await redisPub.connect();
    logger.info("redis.publisher.connected", { redisUrl: redactUrl(REDIS_URL) });

    const redisSub = await startRedisSubscriber();

    server.listen(PORT, () => {
        logger.info("http.listening", { port: PORT, websocketPath: "/prices" });
    });

    const shutdown = async () => {
        try {
            for (const ws of clients) {
                try {
                    ws.close();
                } catch { }
            }
            clients.clear();

            for (const [id, p] of pending) {
                clearTimeout(p.timeout);
                pending.delete(id);
            }
            if (redisSub) await redisSub.quit();
            if (redisPub) await redisPub.quit();
        } finally {
            process.exit(0);
        }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})().catch((e) => {
    logger.error("service.fatal", { error: toSafeError(e) });
    process.exit(1);
});
