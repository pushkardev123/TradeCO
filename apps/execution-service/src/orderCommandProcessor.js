import {
    ORDER_COMMAND_TYPES,
    formatExchangeFilterErrors,
} from "@tradeco/redis-stream-contracts";
import {
    decimalString,
    divideDecimalStrings,
    isPositiveDecimal,
} from "./tradingDecimal.js";

const SUBMITTED_STATUSES = new Set(["SUBMITTED", "PARTIALLY_FILLED", "FILLED"]);
const TERMINAL_STATUSES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
const CANCEL_OPEN_STATUSES = new Set([
    "RECEIVED",
    "PENDING",
    "SUBMITTED",
    "PARTIALLY_FILLED",
    "CANCEL_REQUESTED",
    "CANCEL_PENDING",
    "CANCEL_REJECTED",
    "CANCEL_APPEND_FAILED",
]);

export function normalizeExecutionOrderCommand(input = {}) {
    const orderId = requiredString(input.orderId, "orderId");
    const userId = requiredString(input.userId, "userId");
    const symbol = requiredString(input.symbol, "symbol").toUpperCase();
    const side = requiredString(input.side, "side").toUpperCase();
    const orderType = String(input.orderType || input.type || "MARKET").trim().toUpperCase();
    const quantity = requiredString(input.quantity, "quantity");
    const price = optionalString(input.price);
    const stopPrice = optionalString(input.stopPrice);
    const timeInForce = optionalString(input.timeInForce)?.toUpperCase();

    return {
        commandId: optionalString(input.commandId) || orderId,
        orderId,
        userId,
        symbol,
        side,
        orderType,
        quantity,
        price,
        stopPrice,
        timeInForce,
    };
}

export function normalizeExecutionCancelCommand(input = {}) {
    const orderId = requiredString(input.orderId, "orderId");
    const userId = requiredString(input.userId, "userId");
    const symbol = requiredString(input.symbol, "symbol").toUpperCase();

    return {
        commandId: optionalString(input.commandId) || orderId,
        messageType: ORDER_COMMAND_TYPES.cancel,
        orderId,
        userId,
        symbol,
    };
}

export function normalizeExecutionCancelAllCommand(input = {}) {
    const commandId = requiredString(input.commandId, "commandId");
    const userId = requiredString(input.userId, "userId");
    const symbol = requiredString(input.symbol, "symbol").toUpperCase();

    return {
        commandId,
        messageType: ORDER_COMMAND_TYPES.cancelAll,
        userId,
        symbol,
    };
}

export function parseLegacyOrderCommandMessage(message) {
    let parsed;
    try {
        parsed = JSON.parse(message);
    } catch {
        throw new Error("Legacy order command must be valid JSON");
    }

    return normalizeExecutionOrderCommand(parsed);
}

export async function processOrderCommand(options = {}) {
    const messageType = String(options.command?.messageType || ORDER_COMMAND_TYPES.submit);

    if (messageType === ORDER_COMMAND_TYPES.cancel) {
        return processOrderCancelCommand(options);
    }

    if (messageType === ORDER_COMMAND_TYPES.cancelAll) {
        return processOrderCancelAllCommand(options);
    }

    return processOrderSubmitCommand(options);
}

async function processOrderSubmitCommand({
    command,
    prisma,
    pub,
    eventsChannel,
    loadActiveExchangeCredential,
    validateOrderBeforeSubmit,
    startUserDataStream,
    executeBinanceOrder,
} = {}) {
    const normalized = normalizeExecutionOrderCommand(command);
    const existing = await prisma.orderCommand.findUnique?.({ where: { orderId: normalized.orderId } });

    if (isAlreadySubmitted(existing)) {
        await publishOrderStatusEvent({
            pub,
            eventsChannel,
            command: commandFromExisting(existing, normalized),
            status: existing.status || "SUBMITTED",
            price: existing.avgFillPrice ?? null,
            quantity: quantityFromExisting(existing, normalized),
            binanceOrderId: existing.binanceOrderId,
            clientOrderId: existing.orderId || normalized.orderId,
            submittedAt: existing.submittedAt || new Date(),
        });
        return { outcome: "skipped", reason: "already-submitted", orderId: normalized.orderId };
    }

    await prisma.orderCommand.upsert({
        where: { orderId: normalized.orderId },
        update: { status: "PENDING" },
        create: {
            userId: normalized.userId,
            orderId: normalized.orderId,
            symbol: normalized.symbol,
            side: normalized.side,
            type: normalized.orderType,
            quantity: normalized.quantity,
            price: nullableDecimalString(normalized.price),
            stopPrice: nullableDecimalString(normalized.stopPrice),
            timeInForce: normalized.timeInForce || null,
            status: "PENDING",
        },
    });

    if (validateOrderBeforeSubmit) {
        let validation;
        try {
            validation = await validateOrderBeforeSubmit({ command: normalized });
        } catch (error) {
            await rejectOrder({
                prisma,
                pub,
                eventsChannel,
                command: normalized,
                reason: error?.message || "Exchange filter validation failed",
            });
            return { outcome: "rejected", reason: "exchange-filter-validation", orderId: normalized.orderId };
        }

        if (validation && validation.ok === false) {
            await rejectOrder({
                prisma,
                pub,
                eventsChannel,
                command: normalized,
                reason: formatExchangeFilterErrors(validation.errors) || "Order violates Binance filters",
            });
            return { outcome: "rejected", reason: "exchange-filters", orderId: normalized.orderId };
        }
    }

    let credential;
    try {
        credential = await loadActiveExchangeCredential(prisma, normalized.userId);
    } catch (error) {
        await rejectOrder({
            prisma,
            pub,
            eventsChannel,
            command: normalized,
            reason: error?.message || "Exchange credential not found",
        });
        return { outcome: "rejected", reason: "credential", orderId: normalized.orderId };
    }

    startUserDataStream({
        prisma,
        pub,
        userId: normalized.userId,
        apiKey: credential.apiKey,
        secretKey: credential.secretKey,
    });

    let binanceRes;
    try {
        binanceRes = await executeBinanceOrder({
            apiKey: credential.apiKey,
            secretKey: credential.secretKey,
            symbol: normalized.symbol,
            side: normalized.side,
            orderType: normalized.orderType,
            quantity: normalized.quantity,
            timeInForce: normalized.timeInForce,
            price: normalized.price,
            stopPrice: normalized.stopPrice,
            clientOrderId: normalized.orderId,
        });
    } catch (error) {
        const reason = error?.msg || error?.message || "Binance order failed";
        await rejectOrder({
            prisma,
            pub,
            eventsChannel,
            command: normalized,
            reason,
        });
        return { outcome: "rejected", reason: "binance", orderId: normalized.orderId };
    }

    const transactTime = new Date(binanceRes.transactTime || Date.now());
    const status = normalizeOrderStatus(binanceRes.status);
    const executedQty = nullableDecimalString(binanceRes.executedQty);
    const cummulativeQuoteQty = nullableDecimalString(binanceRes.cummulativeQuoteQty);
    const avgFillPrice = deriveAverageFillPrice({ executedQty, cummulativeQuoteQty });
    const lastTradeQty = nullableDecimalString(binanceRes.fills?.at?.(-1)?.qty);
    const lastTradePrice = nullableDecimalString(binanceRes.fills?.at?.(-1)?.price);

    await prisma.orderCommand.upsert({
        where: { orderId: normalized.orderId },
        update: {
            status,
            rawStatus: optionalString(binanceRes.status) || null,
            binanceOrderId: Number(binanceRes.orderId),
            submittedAt: transactTime,
            executedQty: executedQty ?? "0",
            cummulativeQuoteQty: cummulativeQuoteQty ?? "0",
            avgFillPrice,
            lastTradeQty,
            lastTradePrice,
            lastExchangeUpdateAt: transactTime,
        },
        create: {
            userId: normalized.userId,
            orderId: normalized.orderId,
            symbol: normalized.symbol,
            side: normalized.side,
            type: normalized.orderType,
            quantity: normalized.quantity,
            price: nullableDecimalString(normalized.price),
            stopPrice: nullableDecimalString(normalized.stopPrice),
            timeInForce: normalized.timeInForce || null,
            status,
            rawStatus: optionalString(binanceRes.status) || null,
            binanceOrderId: Number(binanceRes.orderId),
            submittedAt: transactTime,
            executedQty: executedQty ?? "0",
            cummulativeQuoteQty: cummulativeQuoteQty ?? "0",
            avgFillPrice,
            lastTradeQty,
            lastTradePrice,
            lastExchangeUpdateAt: transactTime,
        },
    });

    const eventQuantity = executedQty ?? normalized.quantity;
    await prisma.orderEvent.create({
        data: {
            orderId: normalized.orderId,
            userId: normalized.userId,
            status,
            price: avgFillPrice,
            quantity: eventQuantity,
            timestamp: transactTime,
        },
    });

    await publishOrderStatusEvent({
        pub,
        eventsChannel,
        command: normalized,
        status,
        price: avgFillPrice,
        quantity: eventQuantity,
        binanceOrderId: binanceRes.orderId,
        clientOrderId: binanceRes.clientOrderId,
        submittedAt: transactTime,
    });

    return { outcome: "submitted", orderId: normalized.orderId };
}

export async function processOrderCancelCommand({
    command,
    prisma,
    pub,
    eventsChannel,
    loadActiveExchangeCredential,
    startUserDataStream,
    executeBinanceCancelOrder,
} = {}) {
    const normalized = normalizeExecutionCancelCommand(command);
    const existing = await prisma.orderCommand.findUnique?.({ where: { orderId: normalized.orderId } });

    if (!existing || existing.userId !== normalized.userId) {
        await publishOrderStatusEvent({
            pub,
            eventsChannel,
            command: {
                ...normalized,
                side: existing?.side || null,
                orderType: existing?.type || null,
                quantity: quantityFromExisting(existing, { quantity: 0 }),
            },
            status: "CANCEL_REJECTED",
            price: existing?.avgFillPrice ?? null,
            quantity: quantityFromExisting(existing, { quantity: 0 }),
            reason: "Order not found",
            submittedAt: new Date(),
        });
        return { outcome: "rejected", reason: "order-not-found", orderId: normalized.orderId };
    }

    if (TERMINAL_STATUSES.has(String(existing.status || "").toUpperCase())) {
        await publishOrderStatusEvent({
            pub,
            eventsChannel,
            command: commandFromExisting(existing, normalized),
            status: existing.status,
            price: existing.avgFillPrice ?? null,
            quantity: quantityFromExisting(existing, normalized),
            binanceOrderId: existing.binanceOrderId,
            clientOrderId: existing.orderId || normalized.orderId,
            submittedAt: existing.lastExchangeUpdateAt || existing.updatedAt || new Date(),
        });
        return { outcome: "skipped", reason: "terminal-status", orderId: normalized.orderId };
    }

    await markCancelPending({
        prisma,
        command: commandFromExisting(existing, normalized),
        existing,
        status: "CANCEL_PENDING",
    });

    let credential;
    try {
        credential = await loadActiveExchangeCredential(prisma, normalized.userId);
    } catch (error) {
        await rejectCancelOrder({
            prisma,
            pub,
            eventsChannel,
            command: commandFromExisting(existing, normalized),
            existing,
            reason: error?.message || "Exchange credential not found",
        });
        return { outcome: "rejected", reason: "credential", orderId: normalized.orderId };
    }

    startUserDataStream({
        prisma,
        pub,
        userId: normalized.userId,
        apiKey: credential.apiKey,
        secretKey: credential.secretKey,
    });

    let binanceRes;
    try {
        binanceRes = await executeBinanceCancelOrder({
            apiKey: credential.apiKey,
            secretKey: credential.secretKey,
            symbol: normalized.symbol,
            orderId: normalized.orderId,
            binanceOrderId: existing.binanceOrderId,
        });
    } catch (error) {
        await rejectCancelOrder({
            prisma,
            pub,
            eventsChannel,
            command: commandFromExisting(existing, normalized),
            existing,
            reason: error?.msg || error?.message || "Binance cancel failed",
        });
        return { outcome: "rejected", reason: "binance", orderId: normalized.orderId };
    }

    await persistCanceledOrder({
        prisma,
        pub,
        eventsChannel,
        command: commandFromExisting(existing, normalized),
        existing,
        binanceRes,
    });

    return { outcome: "canceled", orderId: normalized.orderId };
}

export async function processOrderCancelAllCommand({
    command,
    prisma,
    pub,
    eventsChannel,
    loadActiveExchangeCredential,
    startUserDataStream,
    executeBinanceCancelAllOrders,
} = {}) {
    const normalized = normalizeExecutionCancelAllCommand(command);
    const localOpenOrders = await findLocalOpenOrders({ prisma, userId: normalized.userId, symbol: normalized.symbol });

    for (const order of localOpenOrders) {
        await markCancelPending({
            prisma,
            command: commandFromExisting(order, {
                orderId: order.orderId,
                userId: normalized.userId,
                symbol: normalized.symbol,
                quantity: order.quantity,
            }),
            existing: order,
            status: "CANCEL_PENDING",
        });
    }

    let credential;
    try {
        credential = await loadActiveExchangeCredential(prisma, normalized.userId);
    } catch (error) {
        await rejectCancelAllLocalOrders({
            prisma,
            pub,
            eventsChannel,
            orders: localOpenOrders,
            normalized,
            reason: error?.message || "Exchange credential not found",
        });
        return { outcome: "rejected", reason: "credential", symbol: normalized.symbol, affectedCount: localOpenOrders.length };
    }

    startUserDataStream({
        prisma,
        pub,
        userId: normalized.userId,
        apiKey: credential.apiKey,
        secretKey: credential.secretKey,
    });

    let binanceResults;
    try {
        binanceResults = await executeBinanceCancelAllOrders({
            apiKey: credential.apiKey,
            secretKey: credential.secretKey,
            symbol: normalized.symbol,
        });
    } catch (error) {
        await rejectCancelAllLocalOrders({
            prisma,
            pub,
            eventsChannel,
            orders: localOpenOrders,
            normalized,
            reason: error?.msg || error?.message || "Binance cancel-all failed",
        });
        return { outcome: "rejected", reason: "binance", symbol: normalized.symbol, affectedCount: localOpenOrders.length };
    }

    const localByOrderId = new Map(localOpenOrders.map((order) => [order.orderId, order]));
    const localByBinanceOrderId = new Map(
        localOpenOrders
            .filter((order) => order.binanceOrderId !== undefined && order.binanceOrderId !== null)
            .map((order) => [String(order.binanceOrderId), order]),
    );
    let canceledCount = 0;

    for (const binanceRes of Array.isArray(binanceResults) ? binanceResults : []) {
        const clientOrderId = optionalString(binanceRes?.origClientOrderId) || optionalString(binanceRes?.clientOrderId);
        const binanceOrderId = binanceRes?.orderId === undefined || binanceRes?.orderId === null ? null : String(binanceRes.orderId);
        const existing = (clientOrderId && localByOrderId.get(clientOrderId)) ||
            (binanceOrderId && localByBinanceOrderId.get(binanceOrderId));

        if (!existing) continue;

        await persistCanceledOrder({
            prisma,
            pub,
            eventsChannel,
            command: commandFromExisting(existing, {
                orderId: existing.orderId,
                userId: normalized.userId,
                symbol: normalized.symbol,
                quantity: existing.quantity,
            }),
            existing,
            binanceRes,
        });
        canceledCount += 1;
    }

    return {
        outcome: "cancel-all-submitted",
        symbol: normalized.symbol,
        affectedCount: localOpenOrders.length,
        canceledCount,
    };
}

export async function rejectOrder({ prisma, pub, eventsChannel, command, reason }) {
    const now = new Date();

    await prisma.orderEvent.create({
        data: {
            orderId: command.orderId,
            userId: command.userId,
            status: "REJECTED",
            price: null,
            quantity: nullableDecimalString(command.quantity) ?? "0",
            timestamp: now,
        },
    });

    await prisma.orderCommand.upsert({
        where: { orderId: command.orderId },
        update: {
            status: "REJECTED",
            errorMsg: reason,
        },
        create: {
            userId: command.userId,
            orderId: command.orderId,
            symbol: command.symbol,
            side: command.side,
            type: command.orderType,
            quantity: nullableDecimalString(command.quantity) ?? "0",
            price: nullableDecimalString(command.price),
            stopPrice: nullableDecimalString(command.stopPrice),
            timeInForce: command.timeInForce || null,
            status: "REJECTED",
            errorMsg: reason,
        },
    });

    await publishOrderStatusEvent({
        pub,
        eventsChannel,
        command,
        status: "REJECTED",
        price: null,
        quantity: command.quantity,
        reason,
        submittedAt: now,
    });
}

async function markCancelPending({ prisma, command, existing, status }) {
    const now = new Date();
    await prisma.orderCommand.update({
        where: { orderId: command.orderId },
        data: {
            status,
            errorCode: null,
            errorMsg: null,
        },
    });
    await prisma.orderEvent.create({
        data: {
            orderId: command.orderId,
            userId: command.userId,
            status,
            price: existing.avgFillPrice ?? existing.price ?? null,
            quantity: quantityFromExisting(existing, command),
            timestamp: now,
        },
    });
}

async function rejectCancelOrder({ prisma, pub, eventsChannel, command, existing, reason }) {
    const now = new Date();
    const quantity = quantityFromExisting(existing, command);

    await prisma.orderCommand.update({
        where: { orderId: command.orderId },
        data: {
            status: "CANCEL_REJECTED",
            errorMsg: reason,
        },
    });

    await prisma.orderEvent.create({
        data: {
            orderId: command.orderId,
            userId: command.userId,
            status: "CANCEL_REJECTED",
            price: existing.avgFillPrice ?? existing.price ?? null,
            quantity,
            timestamp: now,
        },
    });

    await publishOrderStatusEvent({
        pub,
        eventsChannel,
        command,
        status: "CANCEL_REJECTED",
        price: existing.avgFillPrice ?? existing.price ?? null,
        quantity,
        binanceOrderId: existing.binanceOrderId,
        clientOrderId: command.orderId,
        reason,
        submittedAt: now,
    });
}

async function rejectCancelAllLocalOrders({ prisma, pub, eventsChannel, orders, normalized, reason }) {
    for (const order of orders) {
        await rejectCancelOrder({
            prisma,
            pub,
            eventsChannel,
            command: commandFromExisting(order, {
                orderId: order.orderId,
                userId: normalized.userId,
                symbol: normalized.symbol,
                quantity: order.quantity,
            }),
            existing: order,
            reason,
        });
    }
}

async function persistCanceledOrder({ prisma, pub, eventsChannel, command, existing, binanceRes }) {
    const timestamp = new Date(binanceRes?.updateTime || binanceRes?.transactTime || Date.now());
    const status = normalizeOrderStatus(binanceRes?.status || "CANCELED");
    const executedQty = nullableDecimalString(binanceRes?.executedQty) ?? nullableDecimalString(existing.executedQty);
    const cummulativeQuoteQty = nullableDecimalString(binanceRes?.cummulativeQuoteQty) ?? nullableDecimalString(existing.cummulativeQuoteQty);
    const avgFillPrice = deriveAverageFillPrice({ executedQty, cummulativeQuoteQty }) ?? nullableDecimalString(existing.avgFillPrice);
    const eventQuantity = executedQty ?? quantityFromExisting(existing, command);
    const binanceOrderId = nullableInteger(binanceRes?.orderId) ?? existing.binanceOrderId ?? null;

    await prisma.orderCommand.update({
        where: { orderId: command.orderId },
        data: omitUndefinedFields({
            status,
            rawStatus: optionalString(binanceRes?.status) || status,
            binanceOrderId,
            executedQty: executedQty ?? nullableDecimalString(existing.executedQty) ?? "0",
            cummulativeQuoteQty: cummulativeQuoteQty ?? nullableDecimalString(existing.cummulativeQuoteQty) ?? "0",
            avgFillPrice,
            lastExchangeUpdateAt: timestamp,
            errorCode: null,
            errorMsg: null,
        }),
    });

    await prisma.orderEvent.create({
        data: {
            orderId: command.orderId,
            userId: command.userId,
            status,
            price: avgFillPrice,
            quantity: eventQuantity,
            timestamp,
        },
    });

    await publishOrderStatusEvent({
        pub,
        eventsChannel,
        command,
        status,
        price: avgFillPrice,
        quantity: eventQuantity,
        binanceOrderId,
        clientOrderId: optionalString(binanceRes?.origClientOrderId) || optionalString(binanceRes?.clientOrderId) || command.orderId,
        submittedAt: timestamp,
    });
}

async function findLocalOpenOrders({ prisma, userId, symbol }) {
    if (typeof prisma.orderCommand.findMany !== "function") {
        return [];
    }

    return prisma.orderCommand.findMany({
        where: {
            userId,
            symbol,
            status: { in: Array.from(CANCEL_OPEN_STATUSES) },
        },
        orderBy: { createdAt: "desc" },
    });
}

function isAlreadySubmitted(command) {
    if (!command) return false;
    if (command.binanceOrderId !== undefined && command.binanceOrderId !== null) return true;
    return SUBMITTED_STATUSES.has(String(command.status || "").toUpperCase());
}

function commandFromExisting(existing, fallback) {
    return {
        orderId: existing.orderId || fallback.orderId,
        userId: existing.userId || fallback.userId,
        symbol: existing.symbol || fallback.symbol,
        side: existing.side || fallback.side,
        orderType: existing.type || fallback.orderType,
        quantity: nullableDecimalString(existing.quantity) ?? nullableDecimalString(fallback.quantity) ?? "0",
    };
}

function quantityFromExisting(existing, fallback) {
    if (!existing) {
        return nullableDecimalString(fallback?.quantity) ?? "0";
    }

    const executedQty = nullableDecimalString(existing.executedQty);
    if (isPositiveDecimal(executedQty)) return executedQty;

    return nullableDecimalString(existing.quantity) ?? nullableDecimalString(fallback.quantity) ?? "0";
}

async function publishOrderStatusEvent({
    pub,
    eventsChannel,
    command,
    status,
    price,
    quantity,
    binanceOrderId,
    clientOrderId,
    reason,
    submittedAt,
}) {
    const timestamp = submittedAt instanceof Date ? submittedAt : new Date(submittedAt || Date.now());

    await pub.publish(eventsChannel, JSON.stringify({
        orderId: command.orderId,
        userId: command.userId,
        status,
        symbol: command.symbol,
        side: command.side,
        orderType: command.orderType,
        quantity: nullableDecimalString(quantity),
        price: nullableDecimalString(price),
        binance: {
            orderId: binanceOrderId,
            clientOrderId,
        },
        reason,
        timestamp: timestamp.toISOString(),
    }));
}

function nullableDecimalString(value) {
    if (value === undefined || value === null || value === "") return null;
    return decimalString(value);
}

function nullableInteger(value) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
}

function normalizeOrderStatus(status) {
    const normalized = optionalString(status)?.toUpperCase();

    if (normalized === "FILLED") return "FILLED";
    if (normalized === "PARTIALLY_FILLED") return "PARTIALLY_FILLED";
    if (normalized === "CANCELED") return "CANCELED";
    if (normalized === "EXPIRED") return "EXPIRED";
    if (normalized === "REJECTED") return "REJECTED";

    return "SUBMITTED";
}

function deriveAverageFillPrice({ executedQty, cummulativeQuoteQty }) {
    return divideDecimalStrings(cummulativeQuoteQty, executedQty);
}

function requiredString(value, fieldName) {
    const normalized = optionalString(value);
    if (!normalized) {
        throw new Error(`${fieldName} is required`);
    }
    return normalized;
}

function optionalString(value) {
    if (value === undefined || value === null) return undefined;
    const normalized = String(value).trim();
    return normalized === "" ? undefined : normalized;
}

function omitUndefinedFields(input) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
