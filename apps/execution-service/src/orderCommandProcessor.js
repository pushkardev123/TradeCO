const SUBMITTED_STATUSES = new Set(["SUBMITTED", "PARTIALLY_FILLED", "FILLED"]);

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

export function parseLegacyOrderCommandMessage(message) {
    let parsed;
    try {
        parsed = JSON.parse(message);
    } catch {
        throw new Error("Legacy order command must be valid JSON");
    }

    return normalizeExecutionOrderCommand(parsed);
}

export async function processOrderCommand({
    command,
    prisma,
    pub,
    eventsChannel,
    loadActiveExchangeCredential,
    startUserDataStream,
    executeBinanceOrder,
} = {}) {
    const normalized = normalizeExecutionOrderCommand(command);
    const existing = await prisma.orderCommand.findUnique?.({ where: { orderId: normalized.orderId } });

    if (isAlreadySubmitted(existing)) {
        await publishSubmittedOrderEvent({
            pub,
            eventsChannel,
            command: commandFromExisting(existing, normalized),
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
            quantity: Number(normalized.quantity),
            price: nullableNumber(normalized.price),
            stopPrice: nullableNumber(normalized.stopPrice),
            timeInForce: normalized.timeInForce || null,
            status: "PENDING",
        },
    });

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

    await prisma.orderCommand.upsert({
        where: { orderId: normalized.orderId },
        update: {
            status: "SUBMITTED",
            binanceOrderId: Number(binanceRes.orderId),
            submittedAt: transactTime,
        },
        create: {
            userId: normalized.userId,
            orderId: normalized.orderId,
            symbol: normalized.symbol,
            side: normalized.side,
            type: normalized.orderType,
            quantity: Number(normalized.quantity),
            price: nullableNumber(normalized.price),
            stopPrice: nullableNumber(normalized.stopPrice),
            timeInForce: normalized.timeInForce || null,
            status: "SUBMITTED",
            binanceOrderId: Number(binanceRes.orderId),
            submittedAt: transactTime,
        },
    });

    await publishSubmittedOrderEvent({
        pub,
        eventsChannel,
        command: normalized,
        binanceOrderId: binanceRes.orderId,
        clientOrderId: binanceRes.clientOrderId,
        submittedAt: transactTime,
    });

    return { outcome: "submitted", orderId: normalized.orderId };
}

export async function rejectOrder({ prisma, pub, eventsChannel, command, reason }) {
    const now = new Date();

    await prisma.orderEvent.create({
        data: {
            orderId: command.orderId,
            userId: command.userId,
            status: "REJECTED",
            price: null,
            quantity: Number(command.quantity),
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
            quantity: Number(command.quantity),
            price: nullableNumber(command.price),
            stopPrice: nullableNumber(command.stopPrice),
            timeInForce: command.timeInForce || null,
            status: "REJECTED",
            errorMsg: reason,
        },
    });

    await pub.publish(eventsChannel, JSON.stringify({
        orderId: command.orderId,
        userId: command.userId,
        status: "REJECTED",
        reason,
        timestamp: now.toISOString(),
    }));
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
        quantity: String(existing.quantity ?? fallback.quantity),
    };
}

async function publishSubmittedOrderEvent({
    pub,
    eventsChannel,
    command,
    binanceOrderId,
    clientOrderId,
    submittedAt,
}) {
    const timestamp = submittedAt instanceof Date ? submittedAt : new Date(submittedAt || Date.now());

    await pub.publish(eventsChannel, JSON.stringify({
        orderId: command.orderId,
        userId: command.userId,
        status: "SUBMITTED",
        symbol: command.symbol,
        side: command.side,
        orderType: command.orderType,
        quantity: Number(command.quantity),
        binance: {
            orderId: binanceOrderId,
            clientOrderId,
        },
        timestamp: timestamp.toISOString(),
    }));
}

function nullableNumber(value) {
    if (value === undefined || value === null || value === "") return null;
    return Number(value);
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
