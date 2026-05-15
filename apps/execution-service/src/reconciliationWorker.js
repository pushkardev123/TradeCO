import {
    addDecimalStrings,
    decimalString,
    decimalValuesEqual,
    divideDecimalStrings,
    isPositiveDecimal,
} from "./tradingDecimal.js";

export const RECONCILIATION_ORDER_STATUSES = Object.freeze([
    "PENDING",
    "SUBMITTED",
    "PARTIALLY_FILLED",
    "CANCEL_REQUESTED",
    "CANCEL_PENDING",
]);

export function startReconciliationWorker({
    enabled = true,
    intervalMs = 60000,
    initialDelayMs = 10000,
    logger = console,
    ...options
} = {}) {
    if (!enabled || intervalMs <= 0) {
        return { stop() { } };
    }

    let stopped = false;
    let running = false;
    let timer = null;

    const schedule = (delay) => {
        if (stopped) return;
        timer = setTimeout(tick, delay);
    };

    const tick = async () => {
        if (running || stopped) {
            schedule(intervalMs);
            return;
        }

        running = true;
        try {
            const summary = await runReconciliationCycle({ logger, ...options });
            if (summary.ordersChecked > 0 || summary.accountsPublished > 0 || summary.errors > 0) {
                logger.log?.("[execution] reconciliation cycle", summary);
            }
        } catch (error) {
            logger.warn?.("[execution] reconciliation cycle failed", safeLogMessage(error));
        } finally {
            running = false;
            schedule(intervalMs);
        }
    };

    schedule(initialDelayMs);

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
    };
}

export async function runReconciliationCycle({
    prisma,
    pub,
    eventsChannel,
    balancesChannel,
    loadActiveExchangeCredential,
    fetchOrder,
    fetchMyTrades,
    fetchAccount,
    batchSize = 100,
    staleMs = 30000,
    now = new Date(),
    logger = console,
} = {}) {
    if (!prisma?.orderCommand?.findMany || !prisma?.orderCommand?.update || !prisma?.orderEvent?.create) {
        throw new Error("reconciliation requires orderCommand and orderEvent prisma delegates");
    }
    if (!pub?.publish) throw new Error("reconciliation requires a Redis publisher");
    if (typeof loadActiveExchangeCredential !== "function") throw new Error("loadActiveExchangeCredential is required");
    if (typeof fetchOrder !== "function") throw new Error("fetchOrder is required");

    const staleBefore = new Date(now.getTime() - Math.max(0, staleMs));
    const orders = await prisma.orderCommand.findMany({
        where: {
            status: { in: [...RECONCILIATION_ORDER_STATUSES] },
            updatedAt: { lt: staleBefore },
        },
        orderBy: { updatedAt: "asc" },
        take: Math.max(1, Math.min(batchSize, 500)),
    });

    const credentialsByUser = new Map();
    const reconciledUsers = new Set();
    const summary = {
        ordersChecked: 0,
        ordersUpdated: 0,
        orderEventsCreated: 0,
        accountsPublished: 0,
        errors: 0,
    };

    for (const localOrder of orders) {
        summary.ordersChecked += 1;
        let credential;
        try {
            credential = await getCredential(credentialsByUser, loadActiveExchangeCredential, prisma, localOrder.userId);
            const binanceOrder = await fetchOrder({
                apiKey: credential.apiKey,
                secretKey: credential.secretKey,
                symbol: localOrder.symbol,
                orderId: localOrder.orderId,
                binanceOrderId: localOrder.binanceOrderId,
            });
            const trades = await loadOrderTrades({
                fetchMyTrades,
                credential,
                localOrder,
                binanceOrder,
                logger,
            });
            const result = await reconcileOrder({ prisma, pub, eventsChannel, localOrder, binanceOrder, trades });
            if (result.updated) summary.ordersUpdated += 1;
            if (result.eventCreated) summary.orderEventsCreated += 1;
            reconciledUsers.add(localOrder.userId);
        } catch (error) {
            summary.errors += 1;
            logger.warn?.("[execution] reconciliation skipped order", {
                orderId: localOrder.orderId,
                userId: localOrder.userId,
                reason: safeLogMessage(error),
            });
        }
    }

    if (typeof fetchAccount === "function" && balancesChannel) {
        for (const userId of reconciledUsers) {
            try {
                const credential = await getCredential(credentialsByUser, loadActiveExchangeCredential, prisma, userId);
                const account = await fetchAccount({
                    apiKey: credential.apiKey,
                    secretKey: credential.secretKey,
                    userId,
                });
                const balances = normalizeAccountBalances(account?.balances)
                    .map(({ asset, free, locked }) => ({ asset, free, locked }));
                await pub.publish(balancesChannel, JSON.stringify({
                    type: "ACCOUNT_BALANCES",
                    userId,
                    ts: Date.now(),
                    balances,
                    source: "reconciliation",
                }));
                summary.accountsPublished += 1;
            } catch (error) {
                summary.errors += 1;
                logger.warn?.("[execution] reconciliation account snapshot failed", {
                    userId,
                    reason: safeLogMessage(error),
                });
            }
        }
    }

    return summary;
}

export async function reconcileOrder({ prisma, pub, eventsChannel, localOrder, binanceOrder, trades = [] }) {
    const normalized = normalizeBinanceOrder(binanceOrder, localOrder, trades);
    const materialChange = hasMaterialOrderChange(localOrder, normalized);

    if (!materialChange) {
        return { updated: false, eventCreated: false };
    }

    await prisma.orderCommand.update({
        where: { orderId: localOrder.orderId },
        data: {
            status: normalized.status,
            rawStatus: normalized.rawStatus,
            binanceOrderId: normalized.binanceOrderId,
            executedQty: normalized.executedQty,
            cummulativeQuoteQty: normalized.cummulativeQuoteQty,
            avgFillPrice: normalized.avgFillPrice,
            lastTradeQty: normalized.lastTradeQty,
            lastTradePrice: normalized.lastTradePrice,
            lastExchangeUpdateAt: normalized.timestamp,
            errorCode: null,
            errorMsg: null,
        },
    });

    await prisma.orderEvent.create({
        data: {
            orderId: localOrder.orderId,
            userId: localOrder.userId,
            status: normalized.status,
            price: normalized.avgFillPrice,
            quantity: normalized.eventQuantity,
            timestamp: normalized.timestamp,
        },
    });

    await pub.publish(eventsChannel, JSON.stringify({
        orderId: localOrder.orderId,
        userId: localOrder.userId,
        status: normalized.status,
        symbol: localOrder.symbol,
        side: localOrder.side,
        orderType: localOrder.type,
        quantity: normalized.eventQuantity,
        price: normalized.avgFillPrice,
        binance: {
            orderId: normalized.binanceOrderId,
            clientOrderId: normalized.clientOrderId,
            status: normalized.rawStatus,
        },
        source: "reconciliation",
        timestamp: normalized.timestamp.toISOString(),
    }));

    return { updated: true, eventCreated: true };
}

export function normalizeAccountBalances(balances) {
    const out = [];
    for (const balance of balances || []) {
        const asset = String(balance.asset || balance.a || "").toUpperCase();
        if (!asset) continue;
        const free = decimalString(balance.free ?? balance.f ?? 0) ?? "0";
        const locked = decimalString(balance.locked ?? balance.l ?? 0) ?? "0";
        out.push({ asset, free, locked, total: addDecimalStrings(free, locked) });
    }
    return out;
}

function normalizeBinanceOrder(binanceOrder, localOrder, trades = []) {
    const executedQty = decimalString(binanceOrder?.executedQty) ?? decimalString(localOrder.executedQty) ?? "0";
    const cummulativeQuoteQty = decimalString(binanceOrder?.cummulativeQuoteQty) ?? decimalString(localOrder.cummulativeQuoteQty) ?? "0";
    const avgFillPrice = divideDecimalStrings(cummulativeQuoteQty, executedQty) ?? decimalString(localOrder.avgFillPrice);
    const lastTrade = latestTrade(trades);
    const lastTradeQty = decimalString(lastTrade?.qty) ?? decimalString(localOrder.lastTradeQty);
    const lastTradePrice = decimalString(lastTrade?.price) ?? decimalString(localOrder.lastTradePrice);
    const timestamp = new Date(Number(binanceOrder?.updateTime || binanceOrder?.transactTime || lastTrade?.time) || Date.now());

    return {
        status: mapBinanceOrderStatusToLocal(binanceOrder?.status || localOrder.rawStatus || localOrder.status),
        rawStatus: optionalString(binanceOrder?.status) || optionalString(localOrder.rawStatus) || null,
        binanceOrderId: nullableInteger(binanceOrder?.orderId) ?? localOrder.binanceOrderId ?? null,
        clientOrderId: optionalString(binanceOrder?.clientOrderId) || localOrder.orderId,
        executedQty,
        cummulativeQuoteQty,
        avgFillPrice,
        lastTradeQty,
        lastTradePrice,
        eventQuantity: isPositiveDecimal(executedQty) ? executedQty : decimalString(localOrder.quantity) ?? "0",
        timestamp,
    };
}

function hasMaterialOrderChange(localOrder, normalized) {
    return (
        String(localOrder.status || "") !== normalized.status ||
        String(localOrder.rawStatus || "") !== String(normalized.rawStatus || "") ||
        String(localOrder.binanceOrderId || "") !== String(normalized.binanceOrderId || "") ||
        !decimalValuesEqual(localOrder.executedQty, normalized.executedQty) ||
        !decimalValuesEqual(localOrder.cummulativeQuoteQty, normalized.cummulativeQuoteQty) ||
        !decimalValuesEqual(localOrder.avgFillPrice, normalized.avgFillPrice) ||
        !decimalValuesEqual(localOrder.lastTradeQty, normalized.lastTradeQty) ||
        !decimalValuesEqual(localOrder.lastTradePrice, normalized.lastTradePrice)
    );
}

async function loadOrderTrades({ fetchMyTrades, credential, localOrder, binanceOrder, logger }) {
    if (typeof fetchMyTrades !== "function") return [];
    const binanceOrderId = nullableInteger(binanceOrder?.orderId) ?? localOrder.binanceOrderId;
    if (!binanceOrderId) return [];
    if (!isPositiveDecimal(binanceOrder?.executedQty ?? localOrder.executedQty)) return [];

    try {
        const trades = await fetchMyTrades({
            apiKey: credential.apiKey,
            secretKey: credential.secretKey,
            symbol: localOrder.symbol,
            orderId: binanceOrderId,
            limit: 1000,
        });
        return Array.isArray(trades) ? trades : [];
    } catch (error) {
        logger.warn?.("[execution] reconciliation trades fetch failed", {
            orderId: localOrder.orderId,
            reason: safeLogMessage(error),
        });
        return [];
    }
}

async function getCredential(cache, loadActiveExchangeCredential, prisma, userId) {
    if (!cache.has(userId)) {
        cache.set(userId, await loadActiveExchangeCredential(prisma, userId));
    }
    return cache.get(userId);
}

function latestTrade(trades) {
    return [...(trades || [])].sort((left, right) => Number(right?.time || 0) - Number(left?.time || 0))[0] || null;
}

function mapBinanceOrderStatusToLocal(status) {
    const normalized = String(status || "").toUpperCase();
    if (normalized === "NEW") return "SUBMITTED";
    if (normalized === "PARTIALLY_FILLED") return "PARTIALLY_FILLED";
    if (normalized === "FILLED") return "FILLED";
    if (normalized === "CANCELED") return "CANCELED";
    if (normalized === "EXPIRED") return "EXPIRED";
    if (normalized === "REJECTED") return "REJECTED";
    return "SUBMITTED";
}

function nullableInteger(value) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
}

function optionalString(value) {
    if (value === undefined || value === null) return undefined;
    const normalized = String(value).trim();
    return normalized === "" ? undefined : normalized;
}

function safeLogMessage(error) {
    return String(error?.message || error || "Unknown error")
        .replace(/([?&]signature=)[^&\s]+/gi, "$1<redacted>")
        .replace(/(["']?signature["']?\s*[:=]\s*["']?)[a-f0-9]{16,}/gi, "$1<redacted>");
}
