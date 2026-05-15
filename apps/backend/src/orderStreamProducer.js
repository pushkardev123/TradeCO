import { buildOrderSubmitStreamEntry } from "@tradeco/redis-stream-contracts";

const ORDER_TYPE_ALIASES = Object.freeze({
    STOP_MARKET: "STOP_LOSS",
});

const LIMIT_PRICE_ORDER_TYPES = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT", "LIMIT_MAKER"]);
const STOP_PRICE_ORDER_TYPES = new Set(["STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT"]);
const TIME_IN_FORCE_ORDER_TYPES = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"]);
const TIME_IN_FORCE = new Set(["GTC", "IOC", "FOK"]);

export function createOrderSubmitDraftFromRequest({
    body = {},
    userId,
    orderId,
    requestId,
    createdAt = new Date(),
} = {}) {
    const symbol = normalizeToken(body.symbol);
    const side = normalizeToken(body.side);
    const orderType = normalizeOrderType(body.orderType);
    const quantity = decimalStringFromInput(body.quantity);
    const price = optionalDecimalStringFromInput(body.price);
    const stopPrice = optionalDecimalStringFromInput(body.stopPrice);
    const timeInForce = normalizeTimeInForce({ orderType, value: body.timeInForce });
    const createdAtIso = toIsoString(createdAt);

    validateOrderRequestFields({ symbol, side, orderType, quantity, price, stopPrice, timeInForce });

    const command = {
        commandId: orderId,
        orderId,
        userId,
        symbol,
        side,
        orderType,
        quantity,
        price,
        stopPrice,
        timeInForce,
        requestId: optionalString(requestId),
        source: "backend",
        createdAt: createdAtIso,
        metadata: {},
    };

    let streamEntry;
    try {
        streamEntry = buildOrderSubmitStreamEntry(command);
    } catch (error) {
        throw badRequest(error?.message || "Invalid order submit command");
    }

    return {
        orderId,
        userId,
        symbol,
        side,
        orderType,
        quantity,
        price,
        stopPrice,
        timeInForce,
        createdAt: createdAtIso,
        streamEntry,
    };
}

export async function appendOrderSubmitStreamEntry({ redis, streamName, streamEntry }) {
    return redis.xAdd(streamName, "*", streamEntry);
}

export function isSameOrderIntent(existingCommand, orderDraft) {
    if (!existingCommand || !orderDraft) return false;

    return (
        existingCommand.userId === orderDraft.userId &&
        existingCommand.orderId === orderDraft.orderId &&
        existingCommand.symbol === orderDraft.symbol &&
        existingCommand.side === orderDraft.side &&
        existingCommand.type === orderDraft.orderType &&
        numberFieldMatches(existingCommand.quantity, orderDraft.quantity) &&
        nullableNumberFieldMatches(existingCommand.price, orderDraft.price) &&
        nullableNumberFieldMatches(existingCommand.stopPrice, orderDraft.stopPrice) &&
        nullableStringFieldMatches(existingCommand.timeInForce, orderDraft.timeInForce)
    );
}

export function shouldRetryStreamAppend(existingCommand) {
    return existingCommand?.status === "STREAM_APPEND_FAILED";
}

export function getRequestIdFromHeaders(headers = {}) {
    const value = headers["x-request-id"] ?? headers["X-Request-Id"];
    if (Array.isArray(value)) return optionalString(value[0]);
    return optionalString(value);
}

function validateOrderRequestFields({ symbol, side, orderType, quantity, price, stopPrice, timeInForce }) {
    if (!symbol) {
        throw badRequest("symbol is required");
    }
    if (side !== "BUY" && side !== "SELL") {
        throw badRequest("side must be BUY or SELL");
    }
    if (!isPositiveNumericString(quantity)) {
        throw badRequest("quantity must be > 0");
    }
    if (LIMIT_PRICE_ORDER_TYPES.has(orderType) && !isPositiveNumericString(price)) {
        throw badRequest(`${orderType} requires a valid price`);
    }
    if (STOP_PRICE_ORDER_TYPES.has(orderType) && !isPositiveNumericString(stopPrice)) {
        throw badRequest(`${orderType} requires a valid stopPrice`);
    }
    if (TIME_IN_FORCE_ORDER_TYPES.has(orderType) && !TIME_IN_FORCE.has(timeInForce)) {
        throw badRequest(`${orderType} requires timeInForce`);
    }
}

function normalizeOrderType(value) {
    const orderType = normalizeToken(value || "MARKET");
    return ORDER_TYPE_ALIASES[orderType] || orderType;
}

function normalizeTimeInForce({ orderType, value }) {
    const timeInForce = normalizeToken(value);

    if (!timeInForce && orderType === "LIMIT") {
        return "GTC";
    }

    return timeInForce;
}

function decimalStringFromInput(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }

    if (typeof value === "string") {
        return value.trim();
    }

    return undefined;
}

function optionalDecimalStringFromInput(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    return decimalStringFromInput(value);
}

function isPositiveNumericString(value) {
    if (typeof value !== "string" || value.trim() === "") return false;

    const number = Number(value);
    return Number.isFinite(number) && number > 0;
}

function numberFieldMatches(existingValue, draftValue) {
    const existingNumber = Number(existingValue);
    const draftNumber = Number(draftValue);

    return Number.isFinite(existingNumber) && Number.isFinite(draftNumber) && existingNumber === draftNumber;
}

function nullableNumberFieldMatches(existingValue, draftValue) {
    if (draftValue === undefined || draftValue === null || draftValue === "") {
        return existingValue === undefined || existingValue === null;
    }

    return numberFieldMatches(existingValue, draftValue);
}

function nullableStringFieldMatches(existingValue, draftValue) {
    return (existingValue || null) === (draftValue || null);
}

function normalizeToken(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function optionalString(value) {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toIsoString(value) {
    if (value instanceof Date) {
        return value.toISOString();
    }

    return String(value || new Date().toISOString());
}

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}
