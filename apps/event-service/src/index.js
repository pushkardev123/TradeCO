import http from "http";
import { WebSocketServer } from "ws";
import { createClient } from "redis";
import jwt from "jsonwebtoken";
import "dotenv/config";

const PORT = process.env.PORT || 8081;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const EVENTS_CHANNEL = process.env.EVENTS_CHANNEL || "events:order:status";
const ORDERS_CHANNEL = process.env.ORDERS_CHANNEL || "commands:order:submit";
const PRICES_CHANNEL = process.env.PRICES_CHANNEL || "events:price:update";

const BALANCES_CHANNEL = process.env.BALANCES_CHANNEL || "events:account:balances";
const JWT_SECRET = process.env.JWT_SECRET;

// Charts (candlesticks / klines)
const CHART_REQ_CHANNEL = process.env.CHART_REQ_CHANNEL || "events:chart:request";
const CHARTS_CHANNEL = process.env.CHARTS_CHANNEL || "events:chart:update";

// Account info RPC (event-service -> execution-service)
const ACCOUNT_REQ_CHANNEL = process.env.ACCOUNT_REQ_CHANNEL || "events:account:request";
const ACCOUNT_RES_CHANNEL = process.env.ACCOUNT_RES_CHANNEL || "events:account:response";
const ACCOUNT_CACHE_MS = Number(process.env.ACCOUNT_CACHE_MS || 5 * 1000); // 5s

// Symbol metadata (exchange filters like LOT_SIZE / stepSize / minQty)
const SYMBOL_REQ_CHANNEL = process.env.SYMBOL_REQ_CHANNEL || "events:symbol:request";
const SYMBOL_RES_CHANNEL = process.env.SYMBOL_RES_CHANNEL || "events:symbol:response";
const SYMBOL_CACHE_MS = Number(process.env.SYMBOL_CACHE_MS || 10 * 60 * 1000); // 10 minutes

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

function getBearerToken(req) {
    const header = String(req.headers.authorization || "");
    const [type, token] = header.split(" ");
    if (type !== "Bearer" || !token) return null;
    return token;
}

function verifyAccessToken(token) {
    if (!JWT_SECRET) {
        const err = new Error("JWT_SECRET missing");
        err.statusCode = 503;
        throw err;
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const id = decoded?.userId || decoded?.id || decoded?.sub;
    if (!id) {
        const err = new Error("Token missing user identity");
        err.statusCode = 401;
        throw err;
    }

    return { id: String(id), email: decoded?.email || null };
}

function requireHttpUser(req, res) {
    const token = getBearerToken(req);
    if (!token) {
        sendJson(res, 401, { ok: false, error: "Missing Bearer token" });
        return null;
    }

    try {
        return verifyAccessToken(token);
    } catch (e) {
        const status = e?.statusCode || 401;
        sendJson(res, status, { ok: false, error: status === 503 ? "JWT_SECRET missing" : "Invalid/expired token" });
        return null;
    }
}

function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
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

// --- HTTP server (health + REST endpoints + WS upgrade) ---
const server = http.createServer(async (req, res) => {
    setCors(res);

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
                redisUrl: REDIS_URL,
                eventsChannel: EVENTS_CHANNEL,
                ordersChannel: ORDERS_CHANNEL,
                pricesChannel: PRICES_CHANNEL,
                balancesChannel: BALANCES_CHANNEL,
                chartReqChannel: CHART_REQ_CHANNEL,
                chartsChannel: CHARTS_CHANNEL,
                accountReqChannel: ACCOUNT_REQ_CHANNEL,
                accountResChannel: ACCOUNT_RES_CHANNEL,
                accountCacheMs: ACCOUNT_CACHE_MS,
                symbolReqChannel: SYMBOL_REQ_CHANNEL,
                symbolResChannel: SYMBOL_RES_CHANNEL,
                symbolCacheMs: SYMBOL_CACHE_MS,
                hasPublisher: Boolean(redisPub),
            })
        );
        return;
    }
    // Frontend -> event-service: fetch account balances (pinned + nonZero).
    // User scope comes from the verified access token; userId query params are ignored.
    if (req.url?.startsWith("/account-info") && req.method === "GET") {
        const user = requireHttpUser(req, res);
        if (!user) return;

        try {
            const u = new URL(req.url, `http://localhost:${PORT}`);
            const pinnedParam = String(u.searchParams.get("pinned") || "");
            const pinnedAssets = pinnedParam
                ? pinnedParam.split(",").map((s) => s.trim()).filter(Boolean)
                : [];

            const out = await requestAccountInfo({ userId: user.id, pinnedAssets, timeoutMs: 8000 });
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, fromCache: out.fromCache, data: out.data }));
        } catch (e) {
            console.error("[event-service] /account-info error:", e);
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
            console.error("[event-service] /symbol-info error:", e);
            res.writeHead(504, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: e?.message || "timeout" }));
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

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: CHART_REQ_CHANNEL, request: msg }));
        } catch (e) {
            console.error("[event-service] /charts/subscribe error:", e);
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

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: true, publishedTo: CHART_REQ_CHANNEL, request: msg }));
        } catch (e) {
            console.error("[event-service] /charts/unsubscribe error:", e);
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

// Only accept WS upgrades on /prices. Token is optional for public market data,
// but scoped order/account updates are delivered only when it verifies.
server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", `http://localhost:${PORT}`);
    if (u.pathname !== "/prices") return socket.destroy();

    let user = null;
    const token = u.searchParams.get("token");
    if (token) {
        try {
            user = verifyAccessToken(token);
        } catch {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            return socket.destroy();
        }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = user;
        wss.emit("connection", ws, req);
    });
});

wss.on("connection", (ws) => {
    clients.add(ws);

    ws.send(
        JSON.stringify({
            type: "HELLO",
            message: "connected to /prices",
            authenticated: Boolean(ws.user),
            note: "Broadcasting public market data; scoped order/account updates require a verified token",
            channels: {
                orders: EVENTS_CHANNEL,
                prices: PRICES_CHANNEL,
                balances: BALANCES_CHANNEL,
                chartsRequest: CHART_REQ_CHANNEL,
                charts: CHARTS_CHANNEL,
                symbolRequest: SYMBOL_REQ_CHANNEL,
                symbolResponse: SYMBOL_RES_CHANNEL,
            },
        })
    );

    ws.on("close", () => {
        clients.delete(ws);
    });

    ws.on("error", () => {
        clients.delete(ws);
    });
});

function getMessageUserId(message) {
    try {
        let payload = JSON.parse(message);
        if (typeof payload === "string") payload = JSON.parse(payload);
        return payload?.userId ? String(payload.userId) : null;
    } catch {
        return null;
    }
}

function isScopedChannel(channel) {
    return channel === EVENTS_CHANNEL || channel === BALANCES_CHANNEL || channel === ACCOUNT_RES_CHANNEL;
}

function broadcast(channel, message) {
    const scopedUserId = getMessageUserId(message);
    if (isScopedChannel(channel) && !scopedUserId) return;

    const raw = JSON.stringify({
        type: "REDIS_EVENT",
        channel,
        message,
        ts: Date.now(),
    });

    for (const ws of clients) {
        if (ws.readyState !== 1) {
            clients.delete(ws);
            continue;
        }

        if (scopedUserId && ws.user?.id !== scopedUserId) continue;
        ws.send(raw);
    }
}

// --- Redis subscriber: channels -> WS broadcast ---
async function startRedisSubscriber() {
    const sub = createClient({ url: REDIS_URL });

    sub.on("error", (err) => {
        console.error("[event-service] redis error:", err);
    });

    await sub.connect();
    console.log(`[event-service] redis connected: ${REDIS_URL}`);

    const forward = (channel, message) => {
        broadcast(channel, message);
    };

    await sub.subscribe(EVENTS_CHANNEL, (message) => forward(EVENTS_CHANNEL, message));
    await sub.subscribe(PRICES_CHANNEL, (message) => forward(PRICES_CHANNEL, message));
    await sub.subscribe(CHARTS_CHANNEL, (message) => forward(CHARTS_CHANNEL, message));
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

    console.log(`[event-service] subscribed to: ${EVENTS_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${PRICES_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${CHARTS_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${SYMBOL_RES_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${BALANCES_CHANNEL}`);
    console.log(`[event-service] subscribed to: ${ACCOUNT_RES_CHANNEL}`);

    return sub;
}

// --- Boot ---
(async () => {
    server.listen(PORT, () => {
        console.log(`[event-service] http://localhost:${PORT}`);
        console.log(`[event-service] ws://localhost:${PORT}/prices`);
    });

    try {
        redisPub = createClient({ url: REDIS_URL });
        redisPub.on("error", (err) => console.error("[event-service] redis pub error:", err));
        await redisPub.connect();
        console.log(`[event-service] redis publisher connected: ${REDIS_URL}`);
    } catch (e) {
        console.error("[event-service] failed to start redis publisher:", e);
    }

    let redisSub = null;
    try {
        redisSub = await startRedisSubscriber();
    } catch (e) {
        console.error("[event-service] failed to start redis subscriber:", e);
        console.error("[event-service] Tip: set REDIS_URL env or ensure redis is running on 127.0.0.1:6379");
    }

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
})();