import WebSocket from "ws";
import { createClient } from "redis";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import https from "https";
import querystring from "querystring";
import { config, logStartupConfig, safeErrorMessage } from "./config.js";

const REDIS_URL = config.redisUrl;
const COMMANDS_CHANNEL = config.commandsChannel;
const EVENTS_CHANNEL = config.eventsChannel;
const PRICES_CHANNEL = config.pricesChannel;
// Canonical account/balance fanout channel. Payload:
// { type: "ACCOUNT_BALANCES", userId, ts, balances: [{ asset, free, locked }] }
const BALANCES_CHANNEL = config.balancesChannel;

// Chart (candlestick / kline) streaming (event-service -> execution-service)
const CHART_REQ_CHANNEL = config.chartReqChannel;
const CHARTS_CHANNEL = config.chartsChannel;
const DEFAULT_KLINE_INTERVAL = config.defaultKlineInterval;

// Account info RPC (event-service -> execution-service)
const ACCOUNT_REQ_CHANNEL = config.accountReqChannel;
const ACCOUNT_RES_CHANNEL = config.accountResChannel;
const ACCOUNT_CACHE_MS = config.accountCacheMs;

// Symbol metadata RPC (event-service -> execution-service)
const SYMBOL_REQ_CHANNEL = config.symbolReqChannel;
const SYMBOL_RES_CHANNEL = config.symbolResChannel;
const SYMBOL_CACHE_MS = config.symbolCacheMs;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENC_KEY = Buffer.from(config.encryptionKey, "utf8");

function decrypt(payload) {
    const [ivB64, tagB64, encB64] = String(payload || "").split(".");
    if (!ivB64 || !tagB64 || !encB64) {
        throw new Error("Invalid encrypted payload");
    }

    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const enc = Buffer.from(encB64, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);

    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
}

const BINANCE_API_BASE = config.binanceApiBase;
const BINANCE_WS_BASE = config.binanceWsBase;

// Per-user userDataStream registry
const userStreams = new Map(); // userId -> { listenKey, ws, keepAliveTimer, placeholder: boolean }

// Kline stream registry: key = `${symbol}|${interval}` -> { ws, lastKline, refCount, createdAt }
const klineStreams = new Map();

function klineKey(symbol, interval) {
    return `${String(symbol || "").toUpperCase()}|${String(interval || "").toLowerCase()}`;
}

function normalizeInterval(interval) {
    const iv = String(interval || "").trim();
    return iv ? iv : DEFAULT_KLINE_INTERVAL;
}

function buildKlineWsUrl(symbol, interval) {
    const sym = String(symbol || "").toLowerCase();
    const iv = String(interval || "").toLowerCase();
    return `${BINANCE_WS_BASE}/ws/${sym}@kline_${iv}`;
}

function parseKlineMessage(raw) {
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch {
        return null;
    }
    if (msg?.e !== "kline") return null;
    const k = msg?.k;
    if (!k) return null;

    const symbol = String(msg?.s || k?.s || "").toUpperCase();
    const interval = String(k?.i || "").toLowerCase();

    return {
        symbol,
        interval,
        eventTime: msg?.E ?? null,
        kline: {
            startTime: k?.t ?? null,
            closeTime: k?.T ?? null,
            open: k?.o ?? null,
            high: k?.h ?? null,
            low: k?.l ?? null,
            close: k?.c ?? null,
            volume: k?.v ?? null,
            trades: k?.n ?? null,
            isFinal: Boolean(k?.x),
            quoteVolume: k?.q ?? null,
            takerBuyBaseVolume: k?.V ?? null,
            takerBuyQuoteVolume: k?.Q ?? null,
        },
    };
}

function startKlineStream({ pub, symbol, interval }) {
    const sym = String(symbol || "").toUpperCase();
    const iv = normalizeInterval(interval);
    const key = klineKey(sym, iv);

    const existing = klineStreams.get(key);
    if (existing) {
        existing.refCount += 1;
        return;
    }

    const wsUrl = buildKlineWsUrl(sym, iv);
    console.log("[execution] kline stream connecting:", { key, wsUrl });

    const ws = new WebSocket(wsUrl);

    const entry = {
        ws,
        lastKline: null,
        refCount: 1,
        createdAt: Date.now(),
    };

    klineStreams.set(key, entry);

    ws.on("open", () => {
        console.log("[execution] kline stream connected", { key });
    });

    ws.on("error", (err) => {
        console.error("[execution] kline stream error", { key, err: err?.message || err });
    });

    ws.on("close", (code, reason) => {
        console.warn("[execution] kline stream closed", { key, code, reason: String(reason || "") });
        klineStreams.delete(key);
    });

    ws.on("message", async (raw) => {
        const parsed = parseKlineMessage(raw);
        if (!parsed?.symbol || !parsed?.interval) return;

        entry.lastKline = parsed;

        const out = {
            type: "KLINE_UPDATE",
            ts: Date.now(),
            symbol: parsed.symbol,
            interval: parsed.interval,
            eventTime: parsed.eventTime,
            kline: parsed.kline,
        };

        try {
            await pub.publish(CHARTS_CHANNEL, JSON.stringify(out));
        } catch (e) {
            console.warn("[execution] failed to publish kline update", e?.message || e);
        }
    });
}

function stopKlineStream({ symbol, interval }) {
    const sym = String(symbol || "").toUpperCase();
    const iv = normalizeInterval(interval);
    const key = klineKey(sym, iv);

    const entry = klineStreams.get(key);
    if (!entry) return;

    entry.refCount -= 1;
    if (entry.refCount > 0) return;

    try {
        entry.ws?.close();
    } catch { }

    klineStreams.delete(key);
}

// Very short-lived cache to avoid hammering /api/v3/account
const accountCache = new Map(); // userId -> { ts, data }

function accountCacheGet(userId) {
    const entry = accountCache.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.ts > ACCOUNT_CACHE_MS) {
        accountCache.delete(userId);
        return null;
    }
    return entry.data;
}

function accountCacheSet(userId, data) {
    accountCache.set(userId, { ts: Date.now(), data });
}

function binanceRequest({ method, path, apiKey, body }) {
    return new Promise((resolve, reject) => {
        const url = `${BINANCE_API_BASE}${path}`;
        const req = https.request(
            url,
            {
                method,
                headers: {
                    "X-MBX-APIKEY": apiKey,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    let json;
                    try {
                        json = data ? JSON.parse(data) : {};
                    } catch {
                        json = { raw: data };
                    }
                    if (res.statusCode && res.statusCode >= 400) {
                        const msg = json?.msg || json?.message || `HTTP ${res.statusCode}`;
                        const err = new Error(msg);
                        err.statusCode = res.statusCode;
                        err.body = json;
                        return reject(err);
                    }
                    resolve(json);
                });
            }
        );
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

async function createListenKey(apiKey) {
    const res = await binanceRequest({ method: "POST", path: "/api/v3/userDataStream", apiKey });
    if (!res?.listenKey) throw new Error("Failed to create listenKey");
    return res.listenKey;
}

async function keepAliveListenKey(apiKey, listenKey) {
    const body = querystring.stringify({ listenKey });
    await binanceRequest({ method: "PUT", path: "/api/v3/userDataStream", apiKey, body });
}

async function closeListenKey(apiKey, listenKey) {
    const body = querystring.stringify({ listenKey });
    await binanceRequest({ method: "DELETE", path: "/api/v3/userDataStream", apiKey, body });
}

function mapBinanceOrderStatusToLocal(X) {
    const s = String(X || "").toUpperCase();
    if (s === "FILLED") return "FILLED";
    if (s === "PARTIALLY_FILLED" || s === "NEW") return "PARTIALLY_FILLED";
    if (s === "CANCELED" || s === "REJECTED" || s === "EXPIRED") return "REJECTED";
    return "PARTIALLY_FILLED";
}

async function applyFillToPositions({ prisma, userId, symbol, side, fillQty, fillPrice }) {
    const qty = Number(fillQty);
    const price = Number(fillPrice);
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (!Number.isFinite(price) || price <= 0) return;

    const sym = String(symbol || "").toUpperCase();
    const sd = String(side || "").toUpperCase();

    let pos = null;
    try {
        pos = await prisma.position.findUnique({
            where: { userId_symbol: { userId, symbol: sym } },
        });
    } catch (e) {
        console.warn("[execution] positions table not wired (prisma.position missing?)", e?.message || e);
        return;
    }

    const currentQty = Number(pos?.quantity || 0);
    const currentAvg = Number(pos?.avgPrice || 0);
    const currentRealized = Number(pos?.realizedPnl || 0);

    if (sd === "BUY") {
        const newQty = currentQty + qty;
        const newAvg = newQty > 0 ? (currentAvg * currentQty + price * qty) / newQty : price;
        await prisma.position.upsert({
            where: { userId_symbol: { userId, symbol: sym } },
            update: { quantity: newQty, avgPrice: newAvg },
            create: { userId, symbol: sym, quantity: newQty, avgPrice: newAvg, realizedPnl: currentRealized },
        });
        return;
    }

    if (sd === "SELL") {
        const sold = Math.min(currentQty, qty);
        const newQty = currentQty - sold;
        const realizedDelta = (price - currentAvg) * sold;
        const newRealized = currentRealized + realizedDelta;

        if (newQty <= 0) {
            await prisma.position.delete({
                where: { userId_symbol: { userId, symbol: sym } },
            }).catch(() => { });
            return;
        }

        await prisma.position.upsert({
            where: { userId_symbol: { userId, symbol: sym } },
            update: { quantity: newQty, realizedPnl: newRealized },
            create: { userId, symbol: sym, quantity: newQty, avgPrice: currentAvg, realizedPnl: newRealized },
        });
    }
}

/**
 * FIXED: 
 * 1. Force userId to string to prevent Map key mismatches (Number vs String).
 * 2. Set 'placeholder' in Map synchronously to prevent race conditions from rapid requests.
 */
function startUserDataStream({ prisma, pub, userId, apiKey }) {
    const uid = String(userId); // Ensure standard key format

    // Check if exists OR is currently initializing
    if (userStreams.has(uid)) return;

    // Reserve spot immediately to block duplicate async calls
    userStreams.set(uid, { placeholder: true });

    (async () => {
        let listenKey;
        try {
            listenKey = await createListenKey(apiKey);
        } catch (e) {
            console.error("[execution] Failed to create listenKey for user:", uid, e?.message || e);
            userStreams.delete(uid); // Clean up placeholder on failure
            return;
        }

        const wsUrl = `${BINANCE_WS_BASE}/ws/${listenKey}`;
        console.log("[execution] user data stream connecting:", { userId: uid, wsUrl });

        const ws = new WebSocket(wsUrl);

        const keepAliveTimer = setInterval(async () => {
            try {
                await keepAliveListenKey(apiKey, listenKey);
            } catch (e) {
                console.warn("[execution] listenKey keepAlive failed:", e?.message || e);
            }
        }, 30 * 60 * 1000); // every 30 mins

        // Replace placeholder with real connection data
        userStreams.set(uid, { listenKey, ws, keepAliveTimer, placeholder: false });

        ws.on("open", () => {
            console.log("[execution] user data stream connected", { userId: uid });
        });

        ws.on("close", async (code, reason) => {
            console.warn("[execution] user data stream closed", { userId: uid, code, reason: String(reason || "") });
            const entry = userStreams.get(uid);
            if (entry) {
                if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
                userStreams.delete(uid);
            }
            try {
                await closeListenKey(apiKey, listenKey);
            } catch { }
        });

        ws.on("error", (err) => {
            console.error("[execution] user data stream error", { userId: uid, err: err?.message || err });
        });

        ws.on("message", async (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }

            // 1) Balance updates
            if (msg?.e === "outboundAccountPosition" && Array.isArray(msg?.B)) {
                const balances = msg.B
                    .map((b) => ({ asset: b.a, free: b.f, locked: b.l }))
                    .filter((b) => b.asset);

                await pub.publish(
                    BALANCES_CHANNEL,
                    JSON.stringify({ type: "ACCOUNT_BALANCES", userId: uid, ts: Date.now(), balances })
                );
                return;
            }

            // 2) Order execution reports
            if (msg?.e === "executionReport") {
                const internalOrderId = String(msg?.c || "");
                const symbol = String(msg?.s || "").toUpperCase();
                const side = String(msg?.S || "").toUpperCase();
                const orderType = String(msg?.o || "").toUpperCase();
                const bStatus = String(msg?.X || "").toUpperCase();
                const mappedStatus = mapBinanceOrderStatusToLocal(bStatus);

                const lastQty = Number(msg?.l);
                const lastPrice = Number(msg?.L);

                const cumQty = Number(msg?.z);
                const cumQuote = Number(msg?.Z);
                const avgPrice = Number.isFinite(cumQty) && cumQty > 0 && Number.isFinite(cumQuote) ? cumQuote / cumQty : null;

                const ts = new Date(Number(msg?.T) || Date.now());

                if (internalOrderId) {
                    try {
                        await prisma.orderEvent.create({
                            data: {
                                orderId: internalOrderId,
                                userId: uid, // Use local uid var
                                status: mappedStatus,
                                price: Number.isFinite(avgPrice) ? avgPrice : null,
                                quantity: Number.isFinite(cumQty) ? cumQty : null,
                                timestamp: ts,
                            },
                        });
                    } catch (e) {
                        console.warn("[execution] orderEvent create failed (user stream):", e?.message || e);
                    }

                    try {
                        await prisma.orderCommand.upsert({
                            where: { orderId: internalOrderId },
                            update: {
                                status: mappedStatus,
                                binanceOrderId: msg?.i ? Number(msg.i) : undefined,
                                executedQty: Number.isFinite(cumQty) ? cumQty : 0,
                                cummulativeQuoteQty: Number.isFinite(cumQuote) ? cumQuote : 0,
                                avgFillPrice: Number.isFinite(avgPrice) ? avgPrice : null,
                                lastExchangeUpdateAt: ts,
                            },
                            create: {
                                userId: uid,
                                orderId: internalOrderId,
                                symbol,
                                side,
                                type: orderType,
                                quantity: Number.isFinite(cumQty) ? cumQty : 0,
                                status: mappedStatus,
                                binanceOrderId: msg?.i ? Number(msg.i) : undefined,
                                executedQty: Number.isFinite(cumQty) ? cumQty : 0,
                                cummulativeQuoteQty: Number.isFinite(cumQuote) ? cumQuote : 0,
                                avgFillPrice: Number.isFinite(avgPrice) ? avgPrice : null,
                                lastExchangeUpdateAt: ts,
                            },
                        });
                    } catch (e) {
                        console.warn("[execution] orderCommand upsert failed (user stream):", e?.message || e);
                    }

                    if (Number.isFinite(lastQty) && lastQty > 0 && Number.isFinite(lastPrice) && lastPrice > 0) {
                        await applyFillToPositions({ prisma, userId: uid, symbol, side, fillQty: lastQty, fillPrice: lastPrice });
                    }

                    const out = {
                        orderId: internalOrderId,
                        userId: uid,
                        status: mappedStatus,
                        symbol,
                        side,
                        orderType,
                        quantity: Number.isFinite(cumQty) ? cumQty : null,
                        price: Number.isFinite(avgPrice) ? avgPrice : null,
                        reason: msg?.r ? String(msg.r) : null,
                        binance: {
                            status: bStatus,
                            orderId: msg?.i ?? null,
                            clientOrderId: msg?.c ?? null,
                            eventTime: msg?.E ?? null,
                        },
                        timestamp: ts.toISOString(),
                    };

                    await pub.publish(EVENTS_CHANNEL, JSON.stringify(out));
                }
            }
        });
    })();
}

// In-memory cache: SYMBOL -> { data, ts }
const symbolInfoCache = new Map();

function cacheGetSymbol(symbol) {
    const key = String(symbol || "").toUpperCase();
    const entry = symbolInfoCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > SYMBOL_CACHE_MS) {
        symbolInfoCache.delete(key);
        return null;
    }
    return entry.data;
}

function cacheSetSymbol(symbol, data) {
    const key = String(symbol || "").toUpperCase();
    symbolInfoCache.set(key, { data, ts: Date.now() });
}

function httpsJsonGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: "GET" }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try {
                    const json = JSON.parse(data || "{}");
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(json?.msg || `HTTP ${res.statusCode}`));
                    }
                    resolve(json);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

// ... (fetchKlineSnapshotFromBinance, fetchSymbolInfoFromBinance, getSymbolInfo, signQuery - unchanged)

// Re-include helper functions for brevity
async function fetchKlineSnapshotFromBinance(symbol, interval, limit = 50) {
    const sym = String(symbol || "").toUpperCase();
    const iv = String(interval || DEFAULT_KLINE_INTERVAL).toLowerCase();
    const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
    const qs = querystring.stringify({ symbol: sym, interval: iv, limit: lim });
    const url = `${BINANCE_API_BASE}/api/v3/klines?${qs}`;
    const arr = await httpsJsonGet(url);
    if (!Array.isArray(arr)) throw new Error("klines response is not an array");
    const candles = arr.map((k) => {
        const startTime = Number(k?.[0]);
        const open = Number(k?.[1]);
        const high = Number(k?.[2]);
        const low = Number(k?.[3]);
        const close = Number(k?.[4]);
        const volume = Number(k?.[5]);
        const closeTime = Number(k?.[6]);
        if (!Number.isFinite(startTime) || !Number.isFinite(closeTime)) return null;
        if (![open, high, low, close].every((x) => Number.isFinite(x))) return null;
        return {
            time: Math.floor(startTime / 1000),
            open, high, low, close,
            volume: Number.isFinite(volume) ? volume : 0,
            startTime, closeTime,
        };
    }).filter(Boolean);
    return { symbol: sym, interval: iv, candles };
}
async function fetchSymbolInfoFromBinance(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const qs = querystring.stringify({ symbol: sym });
    const url = `${BINANCE_API_BASE}/api/v3/exchangeInfo?${qs}`;
    const json = await httpsJsonGet(url);
    const s = json?.symbols?.[0];
    if (!s) throw new Error("symbol not found");
    const filters = Array.isArray(s.filters) ? s.filters : [];
    const lot = filters.find((f) => f.filterType === "LOT_SIZE");
    const priceFilter = filters.find((f) => f.filterType === "PRICE_FILTER");
    const notional = filters.find((f) => f.filterType === "MIN_NOTIONAL") || filters.find((f) => f.filterType === "NOTIONAL");
    return {
        symbol: sym, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset,
        minQty: lot?.minQty, maxQty: lot?.maxQty, stepSize: lot?.stepSize,
        tickSize: priceFilter?.tickSize, minPrice: priceFilter?.minPrice, maxPrice: priceFilter?.maxPrice,
        minNotional: notional?.minNotional, maxNotional: notional?.maxNotional,
        applyMinToMarket: notional?.applyMinToMarket ?? false, applyMaxToMarket: notional?.applyMaxToMarket ?? false, avgPriceMins: notional?.avgPriceMins ?? null,
    };
}
async function getSymbolInfo(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const cached = cacheGetSymbol(sym);
    if (cached) return { fromCache: true, data: cached };
    const data = await fetchSymbolInfoFromBinance(sym);
    cacheSetSymbol(sym, data);
    return { fromCache: false, data };
}
function signQuery(query, secret) {
    return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function fetchBinanceAccount({ apiKey, secretKey }) {
    const params = { timestamp: Date.now(), recvWindow: 5000 };
    const query = querystring.stringify(params);
    const signature = signQuery(query, secretKey);
    const url = `${BINANCE_API_BASE}/api/v3/account?${query}&signature=${signature}`;
    return await httpsJsonGetWithApiKey(url, apiKey);
}

function httpsJsonGetWithApiKey(url, apiKey) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: "GET", headers: { "X-MBX-APIKEY": apiKey } }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                let json;
                try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
                if (res.statusCode && res.statusCode >= 400) {
                    const msg = json?.msg || json?.message || `HTTP ${res.statusCode}`;
                    const err = new Error(msg); err.statusCode = res.statusCode; err.body = json; return reject(err);
                }
                resolve(json);
            });
        });
        req.on("error", reject);
        req.end();
    });
}

function normalizeBalances(balances) {
    const out = [];
    for (const b of balances || []) {
        const asset = String(b.asset || b.a || "").toUpperCase();
        const free = Number(b.free ?? b.f ?? 0);
        const locked = Number(b.locked ?? b.l ?? 0);
        if (!asset) continue;
        out.push({ asset, free, locked, total: free + locked });
    }
    return out;
}

function pickPinnedBalances(all, pinnedAssets) {
    const pins = (pinnedAssets || []).map((x) => String(x || "").toUpperCase()).filter(Boolean);
    if (pins.length === 0) return [];
    const set = new Set(pins);
    return all.filter((b) => set.has(b.asset));
}

async function executeBinanceOrder({ apiKey, secretKey, symbol, side, orderType, quantity, timeInForce, price, stopPrice, clientOrderId }) {
    const type = String(orderType || "MARKET").toUpperCase();
    const mappedType = type === "STOP_MARKET" ? "STOP_LOSS" : type;
    const params = {
        symbol: String(symbol || "").toUpperCase(),
        side: String(side || "").toUpperCase(),
        type: mappedType,
        timestamp: Date.now(),
        recvWindow: 5000,
    };
    if (quantity === undefined || quantity === null) throw new Error("quantity is required");
    params.quantity = quantity;
    if (clientOrderId) params.newClientOrderId = String(clientOrderId);
    if (mappedType === "LIMIT") {
        if (price === undefined || price === null || Number(price) <= 0) throw new Error("LIMIT requires a valid price");
        params.price = price;
        params.timeInForce = String(timeInForce || "GTC").toUpperCase();
    }
    if (mappedType === "STOP_LOSS" || mappedType === "TAKE_PROFIT") {
        if (stopPrice === undefined || stopPrice === null || Number(stopPrice) <= 0) throw new Error(`${mappedType} requires a valid stopPrice`);
        params.stopPrice = stopPrice;
    }
    const query = querystring.stringify(params);
    const signature = signQuery(query, secretKey);
    const path = `/api/v3/order?${query}&signature=${signature}`;
    return new Promise((resolve, reject) => {
        const req = https.request(`${BINANCE_API_BASE}${path}`, { method: "POST", headers: { "X-MBX-APIKEY": apiKey } }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    if (json.code && json.code < 0) return reject(json);
                    resolve(json);
                } catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

async function main() {
    logStartupConfig();

    const sub = createClient({ url: REDIS_URL });
    const pub = createClient({ url: REDIS_URL });

    sub.on("error", (e) => console.error("[execution] redis sub error:", safeErrorMessage(e)));
    pub.on("error", (e) => console.error("[execution] redis pub error:", safeErrorMessage(e)));

    const prisma = new PrismaClient();

    await prisma.$connect();
    await sub.connect();
    await pub.connect();

    console.log("[execution] redis connected");
    console.log(`[execution] subscribing: ${COMMANDS_CHANNEL}`);
    console.log(`[execution] subscribing: ${SYMBOL_REQ_CHANNEL}`);
    console.log(`[execution] subscribing: ${ACCOUNT_REQ_CHANNEL}`);
    console.log(`[execution] subscribing: ${CHART_REQ_CHANNEL}`);

    await sub.subscribe(CHART_REQ_CHANNEL, async (message) => {
        let req;
        try { req = JSON.parse(message); } catch { return; }
        const type = String(req?.type || "").toUpperCase();
        const symbol = String(req?.symbol || "").toUpperCase();
        const interval = normalizeInterval(req?.interval);
        if (!symbol) return;

        if (type === "CHART_UNSUBSCRIBE") {
            stopKlineStream({ symbol, interval });
            return;
        }

        try {
            const snap = await fetchKlineSnapshotFromBinance(symbol, interval, 500);
            const snapshotEvent = {
                type: "KLINE_SNAPSHOT",
                ts: Date.now(),
                symbol: snap.symbol,
                interval: snap.interval,
                candles: snap.candles,
                source: "REST",
            };
            await pub.publish(CHARTS_CHANNEL, JSON.stringify(snapshotEvent));
        } catch (e) {
            console.warn("[execution] failed to fetch/publish kline snapshot", { symbol, interval, err: e?.message || e });
        }
        startKlineStream({ pub, symbol, interval });
    });

    await sub.subscribe(SYMBOL_REQ_CHANNEL, async (message) => {
        let req; try { req = JSON.parse(message); } catch { return; }
        if (req?.type !== "SYMBOL_INFO_REQUEST") return;
        const id = req?.id;
        const symbol = String(req?.symbol || "").toUpperCase();
        const replyTo = String(req?.replyTo || SYMBOL_RES_CHANNEL);
        const baseResp = { type: "SYMBOL_INFO_RESPONSE", id, symbol, ts: Date.now() };

        if (!id || !symbol) { await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: false, error: "id and symbol are required" })); return; }
        try {
            const out = await getSymbolInfo(symbol);
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: true, data: out.data, fromCache: out.fromCache }));
        } catch (e) {
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: false, error: e?.message || "failed" }));
        }
    });

    await sub.subscribe(ACCOUNT_REQ_CHANNEL, async (message) => {
        let req;
        try { req = JSON.parse(message); } catch { return; }
        if (req?.type !== "ACCOUNT_INFO_REQUEST") return;

        const id = req?.id;
        const userId = String(req?.userId || "");
        const replyTo = String(req?.replyTo || ACCOUNT_RES_CHANNEL);
        const pinnedAssets = Array.isArray(req?.pinnedAssets) ? req.pinnedAssets : [];
        const baseResp = { type: "ACCOUNT_INFO_RESPONSE", id, userId, ts: Date.now() };

        if (!id || !userId) { await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: false, error: "id and userId are required" })); return; }

        const cached = accountCacheGet(userId);
        if (cached) {
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: true, fromCache: true, data: cached }));
            // Try to start stream even on cache hit, to handle server restarts or reconnections
            try {
                const user = await prisma.user.findUnique({ where: { id: userId }, select: { binanceApiKeyEnc: true } });
                if (user?.binanceApiKeyEnc) {
                    const apiKey = decrypt(user.binanceApiKeyEnc);
                    // Force startUserDataStream call, which now safely handles duplicates via Map check
                    startUserDataStream({ prisma, pub, userId, apiKey });
                }
            } catch { }
            return;
        }

        let apiKey;
        let secretKey;
        try {
            const user = await prisma.user.findUnique({ where: { id: userId }, select: { binanceApiKeyEnc: true, binanceSecretKeyEnc: true } });
            if (!user) throw new Error("User not found");
            apiKey = decrypt(user.binanceApiKeyEnc);
            secretKey = decrypt(user.binanceSecretKeyEnc);
        } catch (e) {
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: false, error: e?.message || "failed to load keys" }));
            return;
        }

        // IMPORTANT: Start stream immediately on first data request
        startUserDataStream({ prisma, pub, userId, apiKey });

        try {
            const account = await fetchBinanceAccount({ apiKey, secretKey });
            const all = normalizeBalances(account?.balances);
            const nonZero = all.filter((b) => Number(b.total) > 0);
            const pinned = pickPinnedBalances(all, pinnedAssets);
            const data = { updateTime: account?.updateTime ?? null, accountType: account?.accountType ?? null, pinned, nonZero };
            accountCacheSet(userId, data);
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: true, fromCache: false, data }));
            try {
                await pub.publish(BALANCES_CHANNEL, JSON.stringify({ type: "ACCOUNT_BALANCES", userId, ts: Date.now(), balances: all.map(({ asset, free, locked }) => ({ asset, free, locked })) }));
            } catch { }
        } catch (e) {
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: false, error: e?.message || "failed to fetch account" }));
        }
    });

    const MARKET_MODE = config.marketMode;
    const SYMBOLS = config.symbols;
    let wsUrl = MARKET_MODE === "all" ? `${BINANCE_WS_BASE}/ws/!miniTicker@arr` : `${BINANCE_WS_BASE}/stream?streams=${SYMBOLS.map((s) => `${s}@trade`).join("/")}`;
    let binanceSocket;
    let wsReconnectTimer;

    const startBinanceWs = () => {
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        binanceSocket = new WebSocket(wsUrl);
        binanceSocket.on("open", () => console.log("[execution] market stream connected"));
        binanceSocket.on("close", () => { wsReconnectTimer = setTimeout(startBinanceWs, 1500); });
        binanceSocket.on("message", async (raw) => {
            try {
                const parsed = JSON.parse(raw.toString());
                if (MARKET_MODE === "all") {
                    if (!Array.isArray(parsed)) return;
                    const tickers = parsed.map((t) => ({ symbol: String(t.s || "").toUpperCase(), price: Number(t.c) })).filter((t) => t.symbol && Number.isFinite(t.price));
                    await pub.publish(PRICES_CHANNEL, JSON.stringify({ type: "MARKET_BOARD", ts: Date.now(), data: tickers }));
                    return;
                }
                const data = parsed?.data;
                if (!data || data.e !== "trade") return;
                await pub.publish(PRICES_CHANNEL, JSON.stringify({ type: "PRICE_UPDATE", symbol: String(data.s).toUpperCase(), price: Number(data.p), ts: Number(data.T) }));
            } catch (e) { }
        });
    };
    startBinanceWs();

    await sub.subscribe(COMMANDS_CHANNEL, async (message) => {
        let cmd; try { cmd = JSON.parse(message); } catch { return; }
        const orderType = String(cmd?.orderType || "MARKET").toUpperCase();

        // Ensure standard string ID for consistency with Account Requests
        const uid = String(cmd.userId);

        try {
            await prisma.orderCommand.upsert({
                where: { orderId: cmd.orderId },
                update: { status: "PENDING" },
                create: { userId: uid, orderId: cmd.orderId, symbol: cmd.symbol, side: cmd.side, type: orderType, quantity: Number(cmd.quantity), status: "PENDING" },
            });
        } catch { }

        let binanceApiKey = null;
        let binanceSecretKey = null;

        try {
            const user = await prisma.user.findUnique({ where: { id: uid }, select: { binanceApiKeyEnc: true, binanceSecretKeyEnc: true } });
            if (!user) throw new Error(`User not found for userId=${uid}`);
            binanceApiKey = decrypt(user.binanceApiKeyEnc);
            binanceSecretKey = decrypt(user.binanceSecretKeyEnc);
        } catch (e) {
            const now = new Date();
            await prisma.orderEvent.create({ data: { orderId: cmd.orderId, userId: uid, status: "REJECTED", price: null, quantity: Number(cmd.quantity), timestamp: now } }).catch(() => { });
            await prisma.orderCommand.upsert({ where: { orderId: cmd.orderId }, update: { status: "REJECTED" }, create: { userId: uid, orderId: cmd.orderId, symbol: cmd.symbol, side: cmd.side, type: orderType, quantity: Number(cmd.quantity), status: "REJECTED" } }).catch(() => { });
            await pub.publish(EVENTS_CHANNEL, JSON.stringify({ orderId: cmd.orderId, userId: uid, status: "REJECTED", reason: e?.message, timestamp: now.toISOString() }));
            return;
        }

        // Start stream using the standard string UID
        startUserDataStream({ prisma, pub, userId: uid, apiKey: binanceApiKey });

        try {
            const binanceRes = await executeBinanceOrder({ apiKey: binanceApiKey, secretKey: binanceSecretKey, symbol: cmd.symbol, side: cmd.side, orderType, quantity: cmd.quantity, timeInForce: cmd.timeInForce, price: cmd.price, stopPrice: cmd.stopPrice, clientOrderId: cmd.orderId });
            const transactTime = new Date(binanceRes.transactTime || Date.now());

            await prisma.orderCommand.upsert({
                where: { orderId: cmd.orderId },
                update: { status: "SUBMITTED", binanceOrderId: Number(binanceRes.orderId), submittedAt: transactTime },
                create: { userId: uid, orderId: cmd.orderId, symbol: cmd.symbol, side: cmd.side, type: orderType, quantity: Number(cmd.quantity), status: "SUBMITTED", binanceOrderId: Number(binanceRes.orderId), submittedAt: transactTime },
            }).catch(() => { });

            await pub.publish(EVENTS_CHANNEL, JSON.stringify({ orderId: cmd.orderId, userId: uid, status: "SUBMITTED", symbol: cmd.symbol, side: cmd.side, orderType, quantity: Number(cmd.quantity), binance: { orderId: binanceRes.orderId, clientOrderId: binanceRes.clientOrderId }, timestamp: transactTime.toISOString() }));
        } catch (err) {
            const reason = err?.msg || err?.message || "Binance order failed";
            const now = new Date();
            await prisma.orderEvent.create({ data: { orderId: cmd.orderId, userId: uid, status: "REJECTED", price: null, quantity: Number(cmd.quantity), timestamp: now } }).catch(() => { });
            await prisma.orderCommand.upsert({ where: { orderId: cmd.orderId }, update: { status: "REJECTED", errorMsg: reason }, create: { userId: uid, orderId: cmd.orderId, symbol: cmd.symbol, side: cmd.side, type: orderType, quantity: Number(cmd.quantity), status: "REJECTED", errorMsg: reason } }).catch(() => { });
            await pub.publish(EVENTS_CHANNEL, JSON.stringify({ orderId: cmd.orderId, userId: uid, status: "REJECTED", reason, timestamp: now.toISOString() }));
        }
    });

    const shutdown = async () => {
        for (const [uid, entry] of userStreams.entries()) { try { clearInterval(entry.keepAliveTimer); entry.ws?.close(); } catch { } userStreams.delete(uid); }
        try { await sub.quit(); await pub.quit(); await prisma.$disconnect(); } catch { }
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("[execution] fatal:", safeErrorMessage(e)); process.exit(1); });
