import WebSocket from "ws";
import { createClient } from "redis";
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { config, logStartupConfig, safeErrorMessage } from "./config.js";
import { createBinanceSpotTestnetClient } from "./binanceSpotTestnetClient.js";
import {
    buildUserDataStreamSubscribeRequest,
    buildUserDataStreamUnsubscribeRequest,
    getUserDataStreamSubscriptionId,
    isUserDataStreamSubscribeAck,
    parseUserDataStreamMessage,
} from "./binanceUserDataStream.js";
import {
    parseLegacyOrderCommandMessage,
    processOrderCommand,
} from "./orderCommandProcessor.js";
import { startOrderStreamConsumer } from "./redisOrderStreamConsumer.js";
import { startReconciliationWorker } from "./reconciliationWorker.js";
import {
    addDecimalStrings,
    decimalOrZero,
    decimalString,
    divideDecimalStrings,
    isPositiveDecimal,
} from "./tradingDecimal.js";

const REDIS_URL = config.redisUrl;
const COMMANDS_CHANNEL = config.commandsChannel;
const LEGACY_COMMANDS_CHANNEL_ENABLED = config.legacyCommandsChannelEnabled;
const EVENTS_CHANNEL = config.eventsChannel;
const ORDER_COMMAND_STREAM = config.orderCommandStream;
const ORDER_COMMAND_DLQ_STREAM = config.orderCommandDlqStream;
const ORDER_COMMAND_CONSUMER_GROUP = config.orderCommandConsumerGroup;
const ORDER_COMMAND_CONSUMER_NAME = config.orderCommandConsumerName;
const ORDER_COMMAND_READ_COUNT = config.orderCommandReadCount;
const ORDER_COMMAND_CLAIM_IDLE_MS = config.orderCommandClaimIdleMs;
const ORDER_COMMAND_MAX_ATTEMPTS = config.orderCommandMaxAttempts;
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
const RECONCILIATION_ENABLED = config.reconciliationEnabled;
const RECONCILIATION_INTERVAL_MS = config.reconciliationIntervalMs;
const RECONCILIATION_STALE_MS = config.reconciliationStaleMs;
const RECONCILIATION_BATCH_SIZE = config.reconciliationBatchSize;

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

const BINANCE_TESTNET_EXCHANGE = "BINANCE_SPOT_TESTNET";

async function loadActiveExchangeCredential(prisma, userId) {
    const credential = await prisma.exchangeCredential.findFirst({
        where: {
            userId,
            exchange: BINANCE_TESTNET_EXCHANGE,
            isActive: true,
        },
        orderBy: { createdAt: "desc" },
        select: {
            apiKeyEnc: true,
            secretKeyEnc: true,
        },
    });

    if (!credential) {
        throw new Error("Exchange credential not found");
    }

    return {
        apiKey: decrypt(credential.apiKeyEnc),
        secretKey: decrypt(credential.secretKeyEnc),
    };
}

const BINANCE_API_BASE = config.binanceApiBase;
const BINANCE_WS_BASE = config.binanceWsBase;
const BINANCE_WS_API_BASE = config.binanceWsApiBase;
const binanceClient = createBinanceSpotTestnetClient({ baseUrl: BINANCE_API_BASE });

// Per-user userDataStream registry
const userStreams = new Map(); // userId -> { ws, subscriptionId, placeholder: boolean }

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

function mapBinanceOrderStatusToLocal(X) {
    const s = String(X || "").toUpperCase();
    if (s === "FILLED") return "FILLED";
    if (s === "PARTIALLY_FILLED" || s === "NEW") return "PARTIALLY_FILLED";
    if (s === "CANCELED") return "CANCELED";
    if (s === "REJECTED") return "REJECTED";
    if (s === "EXPIRED") return "EXPIRED";
    return "PARTIALLY_FILLED";
}

async function applyFillToPositions({ prisma, userId, symbol, side, fillQty, fillPrice }) {
    const qtyValue = decimalString(fillQty);
    const priceValue = decimalString(fillPrice);
    if (!isPositiveDecimal(qtyValue)) return;
    if (!isPositiveDecimal(priceValue)) return;

    const qty = decimalOrZero(qtyValue);
    const price = decimalOrZero(priceValue);

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

    const currentQty = decimalOrZero(pos?.quantity);
    const currentAvg = decimalOrZero(pos?.avgPrice);
    const currentRealized = decimalOrZero(pos?.realizedPnl);

    if (sd === "BUY") {
        const newQty = currentQty.plus(qty);
        const newAvg = newQty.gt(0) ? currentAvg.times(currentQty).plus(price.times(qty)).div(newQty) : price;
        await prisma.position.upsert({
            where: { userId_symbol: { userId, symbol: sym } },
            update: { quantity: newQty.toFixed(), avgPrice: newAvg.toFixed() },
            create: { userId, symbol: sym, quantity: newQty.toFixed(), avgPrice: newAvg.toFixed(), realizedPnl: currentRealized.toFixed() },
        });
        return;
    }

    if (sd === "SELL") {
        const sold = currentQty.lt(qty) ? currentQty : qty;
        const newQty = currentQty.minus(sold);
        const realizedDelta = price.minus(currentAvg).times(sold);
        const newRealized = currentRealized.plus(realizedDelta);

        if (newQty.lte(0)) {
            await prisma.position.delete({
                where: { userId_symbol: { userId, symbol: sym } },
            }).catch(() => { });
            return;
        }

        await prisma.position.upsert({
            where: { userId_symbol: { userId, symbol: sym } },
            update: { quantity: newQty.toFixed(), realizedPnl: newRealized.toFixed() },
            create: { userId, symbol: sym, quantity: newQty.toFixed(), avgPrice: currentAvg.toFixed(), realizedPnl: newRealized.toFixed() },
        });
    }
}

function startUserDataStream({ prisma, pub, userId, apiKey, secretKey }) {
    const uid = String(userId);

    if (userStreams.has(uid)) return;

    userStreams.set(uid, { placeholder: true });

    (async () => {
        console.log("[execution] user data stream connecting:", { userId: uid, wsUrl: BINANCE_WS_API_BASE });

        const ws = new WebSocket(BINANCE_WS_API_BASE);
        const entry = {
            ws,
            subscriptionId: null,
            subscribeRequestId: null,
            shouldReconnect: true,
            placeholder: false,
        };

        userStreams.set(uid, entry);

        ws.on("open", () => {
            try {
                const request = buildUserDataStreamSubscribeRequest({ apiKey, secretKey });
                entry.subscribeRequestId = request.id;
                ws.send(JSON.stringify(request));
                console.log("[execution] user data stream subscription requested", { userId: uid });
            } catch (e) {
                entry.shouldReconnect = false;
                console.error("[execution] user data stream subscription request failed", { userId: uid, err: e?.message || e });
                try { ws.close(); } catch { }
            }
        });

        ws.on("close", (code, reason) => {
            console.warn("[execution] user data stream closed", { userId: uid, code, reason: String(reason || "") });
            const current = userStreams.get(uid);
            if (current === entry) {
                userStreams.delete(uid);
                if (entry.shouldReconnect) {
                    setTimeout(() => {
                        startUserDataStream({ prisma, pub, userId: uid, apiKey, secretKey });
                    }, 1500);
                }
            }
        });

        ws.on("error", (err) => {
            console.error("[execution] user data stream error", { userId: uid, err: err?.message || err });
        });

        ws.on("message", async (raw) => {
            const parsed = parseUserDataStreamMessage(raw);
            if (parsed.kind === "invalid") {
                return;
            }

            if (parsed.kind === "response") {
                if (isUserDataStreamSubscribeAck(parsed, entry.subscribeRequestId)) {
                    entry.subscriptionId = getUserDataStreamSubscriptionId(parsed);
                    console.log("[execution] user data stream subscribed", { userId: uid, subscriptionId: entry.subscriptionId });
                    return;
                }

                if (parsed.raw?.id === entry.subscribeRequestId && Number(parsed.raw?.status) >= 400) {
                    entry.shouldReconnect = false;
                    console.warn("[execution] user data stream subscription rejected", {
                        userId: uid,
                        status: parsed.raw?.status,
                        error: parsed.raw?.error?.msg || parsed.raw?.error?.message || "subscription failed",
                    });
                    try { ws.close(); } catch { }
                }
                return;
            }

            const msg = parsed.event;
            if (!msg) return;

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

                const lastQty = decimalString(msg?.l);
                const lastPrice = decimalString(msg?.L);
                const cumQty = decimalString(msg?.z);
                const cumQuote = decimalString(msg?.Z);
                const avgPrice = divideDecimalStrings(cumQuote, cumQty);
                const originalQty = decimalString(msg?.q) ?? cumQty ?? "0";

                const ts = new Date(Number(msg?.T) || Date.now());

                if (internalOrderId) {
                    try {
                        await prisma.orderEvent.create({
                            data: {
                                orderId: internalOrderId,
                                userId: uid, // Use local uid var
                                status: mappedStatus,
                                price: avgPrice,
                                quantity: cumQty,
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
                                executedQty: cumQty ?? "0",
                                cummulativeQuoteQty: cumQuote ?? "0",
                                avgFillPrice: avgPrice,
                                lastExchangeUpdateAt: ts,
                            },
                            create: {
                                userId: uid,
                                orderId: internalOrderId,
                                symbol,
                                side,
                                type: orderType,
                                quantity: originalQty,
                                status: mappedStatus,
                                binanceOrderId: msg?.i ? Number(msg.i) : undefined,
                                executedQty: cumQty ?? "0",
                                cummulativeQuoteQty: cumQuote ?? "0",
                                avgFillPrice: avgPrice,
                                lastExchangeUpdateAt: ts,
                            },
                        });
                    } catch (e) {
                        console.warn("[execution] orderCommand upsert failed (user stream):", e?.message || e);
                    }

                    if (isPositiveDecimal(lastQty) && isPositiveDecimal(lastPrice)) {
                        await applyFillToPositions({ prisma, userId: uid, symbol, side, fillQty: lastQty, fillPrice: lastPrice });
                    }

                    const out = {
                        orderId: internalOrderId,
                        userId: uid,
                        status: mappedStatus,
                        symbol,
                        side,
                        orderType,
                        quantity: cumQty,
                        price: avgPrice,
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

function stopUserDataStream(uid, entry) {
    if (!entry) return;
    entry.shouldReconnect = false;

    if (entry.ws?.readyState === WebSocket.OPEN && entry.subscriptionId !== null) {
        try {
            entry.ws.send(JSON.stringify(buildUserDataStreamUnsubscribeRequest({ subscriptionId: entry.subscriptionId })));
        } catch { }
    }

    try {
        entry.ws?.close();
    } catch { }
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

async function fetchKlineSnapshotFromBinance(symbol, interval, limit = 50) {
    return binanceClient.fetchKlineSnapshot({ symbol, interval: interval || DEFAULT_KLINE_INTERVAL, limit });
}

async function fetchSymbolInfoFromBinance(symbol) {
    return binanceClient.fetchSymbolInfo({ symbol });
}

async function getSymbolInfo(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const cached = cacheGetSymbol(sym);
    if (cached) return { fromCache: true, data: cached };
    const data = await fetchSymbolInfoFromBinance(sym);
    cacheSetSymbol(sym, data);
    return { fromCache: false, data };
}

async function fetchBinanceAccount({ apiKey, secretKey }) {
    return binanceClient.getAccount({ apiKey, secretKey });
}

async function fetchBinanceOrder({ apiKey, secretKey, symbol, orderId, binanceOrderId }) {
    return binanceClient.getOrder({ apiKey, secretKey, symbol, orderId, binanceOrderId });
}

async function fetchBinanceMyTrades({ apiKey, secretKey, symbol, orderId, startTime, endTime, fromId, limit }) {
    return binanceClient.getMyTrades({ apiKey, secretKey, symbol, orderId, startTime, endTime, fromId, limit });
}

function normalizeBalances(balances) {
    const out = [];
    for (const b of balances || []) {
        const asset = String(b.asset || b.a || "").toUpperCase();
        const free = decimalString(b.free ?? b.f ?? 0) ?? "0";
        const locked = decimalString(b.locked ?? b.l ?? 0) ?? "0";
        if (!asset) continue;
        out.push({ asset, free, locked, total: addDecimalStrings(free, locked) });
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
    return binanceClient.placeOrder({
        apiKey,
        secretKey,
        symbol,
        side,
        orderType,
        quantity,
        timeInForce,
        price,
        stopPrice,
        clientOrderId,
    });
}

async function executeBinanceCancelOrder({ apiKey, secretKey, symbol, orderId, binanceOrderId }) {
    return binanceClient.cancelOrder({
        apiKey,
        secretKey,
        symbol,
        orderId,
        binanceOrderId,
    });
}

async function executeBinanceCancelAllOrders({ apiKey, secretKey, symbol }) {
    return binanceClient.cancelAllOpenOrders({
        apiKey,
        secretKey,
        symbol,
    });
}

async function main() {
    logStartupConfig();

    const sub = createClient({ url: REDIS_URL });
    const pub = createClient({ url: REDIS_URL });
    const stream = createClient({ url: REDIS_URL });

    sub.on("error", (e) => console.error("[execution] redis sub error:", safeErrorMessage(e)));
    pub.on("error", (e) => console.error("[execution] redis pub error:", safeErrorMessage(e)));
    stream.on("error", (e) => console.error("[execution] redis stream error:", safeErrorMessage(e)));

    const prisma = new PrismaClient();

    await prisma.$connect();
    await sub.connect();
    await pub.connect();
    await stream.connect();

    console.log("[execution] redis connected");
    console.log(`[execution] consuming stream: ${ORDER_COMMAND_STREAM} group=${ORDER_COMMAND_CONSUMER_GROUP} consumer=${ORDER_COMMAND_CONSUMER_NAME}`);
    if (LEGACY_COMMANDS_CHANNEL_ENABLED) {
        console.log(`[execution] subscribing legacy commands fallback: ${COMMANDS_CHANNEL}`);
    } else {
        console.log(`[execution] legacy commands fallback disabled: ${COMMANDS_CHANNEL}`);
    }
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
                const { apiKey, secretKey } = await loadActiveExchangeCredential(prisma, userId);
                // Force startUserDataStream call, which safely handles duplicates via Map check.
                startUserDataStream({ prisma, pub, userId, apiKey, secretKey });
            } catch { }
            return;
        }

        let apiKey;
        let secretKey;
        try {
            const credential = await loadActiveExchangeCredential(prisma, userId);
            apiKey = credential.apiKey;
            secretKey = credential.secretKey;
        } catch (e) {
            await pub.publish(replyTo, JSON.stringify({ ...baseResp, ok: false, error: e?.message || "failed to load keys" }));
            return;
        }

        // IMPORTANT: Start stream immediately on first data request
        startUserDataStream({ prisma, pub, userId, apiKey, secretKey });

        try {
            const account = await fetchBinanceAccount({ apiKey, secretKey });
            const all = normalizeBalances(account?.balances);
            const nonZero = all.filter((b) => isPositiveDecimal(b.total));
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

    const processCommand = (command) => processOrderCommand({
        command,
        prisma,
        pub,
        eventsChannel: EVENTS_CHANNEL,
        loadActiveExchangeCredential,
        startUserDataStream,
        executeBinanceOrder,
        executeBinanceCancelOrder,
        executeBinanceCancelAllOrders,
    });

    const streamConsumer = startOrderStreamConsumer({
        redis: stream,
        streamName: ORDER_COMMAND_STREAM,
        groupName: ORDER_COMMAND_CONSUMER_GROUP,
        consumerName: ORDER_COMMAND_CONSUMER_NAME,
        dlqStreamName: ORDER_COMMAND_DLQ_STREAM,
        readCount: ORDER_COMMAND_READ_COUNT,
        claimIdleMs: ORDER_COMMAND_CLAIM_IDLE_MS,
        maxAttempts: ORDER_COMMAND_MAX_ATTEMPTS,
        processCommand,
        safeErrorMessage,
    });

    const reconciliationWorker = startReconciliationWorker({
        enabled: RECONCILIATION_ENABLED,
        intervalMs: RECONCILIATION_INTERVAL_MS,
        staleMs: RECONCILIATION_STALE_MS,
        batchSize: RECONCILIATION_BATCH_SIZE,
        prisma,
        pub,
        eventsChannel: EVENTS_CHANNEL,
        balancesChannel: BALANCES_CHANNEL,
        loadActiveExchangeCredential,
        fetchOrder: fetchBinanceOrder,
        fetchMyTrades: fetchBinanceMyTrades,
        fetchAccount: fetchBinanceAccount,
        logger: console,
    });

    if (LEGACY_COMMANDS_CHANNEL_ENABLED) {
        await sub.subscribe(COMMANDS_CHANNEL, async (message) => {
            let command;
            try {
                command = parseLegacyOrderCommandMessage(message);
            } catch (error) {
                console.warn("[execution] ignored invalid legacy order command:", safeErrorMessage(error));
                return;
            }

            try {
                await processCommand(command);
            } catch (error) {
                console.error("[execution] legacy order command failed:", safeErrorMessage(error));
            }
        });
    }

    const shutdown = async () => {
        for (const [uid, entry] of userStreams.entries()) {
            stopUserDataStream(uid, entry);
            userStreams.delete(uid);
        }
        streamConsumer.stop();
        reconciliationWorker.stop();
        try { await sub.quit(); await pub.quit(); await stream.quit(); await prisma.$disconnect(); } catch { }
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("[execution] fatal:", safeErrorMessage(e)); process.exit(1); });
