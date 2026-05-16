import { hostname as getHostname } from "node:os";
export * from "./binanceFilterValidation.js";
export * from "./realtimeEventContracts.js";

export const STREAM_CONTRACT_VERSION = "1";

export const ORDER_STREAMS = Object.freeze({
    commands: "tradeco:orders:commands:v1",
    commandDlq: "tradeco:orders:commands:dlq:v1",
    events: "tradeco:orders:events:v1",
});

export const ORDER_CONSUMER_GROUPS = Object.freeze({
    execution: "tradeco:execution:orders:v1",
});

export const ORDER_COMMAND_TYPES = Object.freeze({
    submit: "order.submit.requested.v1",
    cancel: "order.cancel.requested.v1",
    cancelAll: "order.cancel_all.requested.v1",
});

export const ORDER_EVENT_TYPES = Object.freeze({
    accepted: "order.command.accepted.v1",
    processing: "order.command.processing.v1",
    submitted: "order.submitted.v1",
    rejected: "order.rejected.v1",
    failed: "order.failed.v1",
    deadLettered: "order.command.dead_lettered.v1",
});

export const ORDER_SIDES = Object.freeze(["BUY", "SELL"]);

export const ORDER_TYPES = Object.freeze([
    "MARKET",
    "LIMIT",
    "STOP_LOSS",
    "STOP_LOSS_LIMIT",
    "TAKE_PROFIT",
    "TAKE_PROFIT_LIMIT",
    "LIMIT_MAKER",
]);

export const TIME_IN_FORCE = Object.freeze(["GTC", "IOC", "FOK"]);

const LIMIT_PRICE_ORDER_TYPES = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT", "LIMIT_MAKER"]);
const STOP_PRICE_ORDER_TYPES = new Set(["STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT"]);
const TIME_IN_FORCE_ORDER_TYPES = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"]);
const QUOTE_ORDER_QTY_ORDER_TYPES = new Set(["MARKET"]);
const DECIMAL_STRING_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function getOrderStreamConfig(env = process.env) {
    return {
        streams: {
            commands: readOptionalEnv(env, "ORDER_COMMAND_STREAM") || ORDER_STREAMS.commands,
            commandDlq: readOptionalEnv(env, "ORDER_COMMAND_DLQ_STREAM") || ORDER_STREAMS.commandDlq,
            events: readOptionalEnv(env, "ORDER_EVENT_STREAM") || ORDER_STREAMS.events,
        },
        consumerGroups: {
            execution: readOptionalEnv(env, "ORDER_COMMAND_CONSUMER_GROUP") || ORDER_CONSUMER_GROUPS.execution,
        },
        readCount: readPositiveInteger(env, "ORDER_COMMAND_READ_COUNT", 10),
        claimIdleMs: readPositiveInteger(env, "ORDER_COMMAND_CLAIM_IDLE_MS", 30000),
        maxAttempts: readPositiveInteger(env, "ORDER_COMMAND_MAX_ATTEMPTS", 5),
    };
}

export function createOrderCommandConsumerName({
    service = "execution-service",
    hostname = getHostname(),
    instanceId = process.pid,
} = {}) {
    const rawName = [service, hostname, instanceId].filter((part) => part !== undefined && part !== null && part !== "").join(":");
    const sanitized = rawName.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 128);

    return sanitized || "execution-service:consumer";
}

export function validateOrderSubmitCommand(input) {
    const errors = [];

    if (!isPlainObject(input)) {
        return ["command must be an object"];
    }

    const schemaVersion = optionalString(input.schemaVersion) || STREAM_CONTRACT_VERSION;
    const messageType = optionalString(input.messageType) || ORDER_COMMAND_TYPES.submit;
    const side = normalizeToken(input.side);
    const orderType = normalizeToken(input.orderType);
    const hasQuantity = input.quantity !== undefined && input.quantity !== null && input.quantity !== "";
    const hasQuoteOrderQty = input.quoteOrderQty !== undefined && input.quoteOrderQty !== null && input.quoteOrderQty !== "";
    const price = optionalString(input.price);
    const stopPrice = optionalString(input.stopPrice);
    const timeInForce = normalizeToken(input.timeInForce);

    if (schemaVersion !== STREAM_CONTRACT_VERSION) {
        errors.push(`schemaVersion must be ${STREAM_CONTRACT_VERSION}`);
    }

    if (messageType !== ORDER_COMMAND_TYPES.submit) {
        errors.push(`messageType must be ${ORDER_COMMAND_TYPES.submit}`);
    }

    requireNonEmptyString(input.commandId, "commandId", errors);
    requireNonEmptyString(input.orderId, "orderId", errors);
    requireNonEmptyString(input.userId, "userId", errors);
    requireNonEmptyString(input.symbol, "symbol", errors);
    requireNonEmptyString(input.createdAt, "createdAt", errors);

    if (typeof input.createdAt === "string" && Number.isNaN(Date.parse(input.createdAt))) {
        errors.push("createdAt must be an ISO-compatible timestamp");
    }

    if (!ORDER_SIDES.includes(side)) {
        errors.push(`side must be one of ${ORDER_SIDES.join(", ")}`);
    }

    if (!ORDER_TYPES.includes(orderType)) {
        errors.push(`orderType must be one of ${ORDER_TYPES.join(", ")}`);
    }

    if (QUOTE_ORDER_QTY_ORDER_TYPES.has(orderType)) {
        if (!hasQuantity && !hasQuoteOrderQty) {
            errors.push("quantity or quoteOrderQty is required");
        }
        if (hasQuantity && hasQuoteOrderQty) {
            errors.push("quantity and quoteOrderQty are mutually exclusive");
        }
        requireOptionalDecimalString(input.quantity, "quantity", errors);
        requireOptionalDecimalString(input.quoteOrderQty, "quoteOrderQty", errors);
    } else {
        requireDecimalString(input.quantity, "quantity", errors);
        if (hasQuoteOrderQty) {
            errors.push("quoteOrderQty is only supported for MARKET orders");
        }
    }

    if (LIMIT_PRICE_ORDER_TYPES.has(orderType)) {
        requireDecimalString(price, "price", errors);
    } else {
        requireOptionalDecimalString(price, "price", errors);
    }

    if (STOP_PRICE_ORDER_TYPES.has(orderType)) {
        requireDecimalString(stopPrice, "stopPrice", errors);
    } else {
        requireOptionalDecimalString(stopPrice, "stopPrice", errors);
    }

    if (TIME_IN_FORCE_ORDER_TYPES.has(orderType)) {
        if (!TIME_IN_FORCE.includes(timeInForce)) {
            errors.push(`timeInForce must be one of ${TIME_IN_FORCE.join(", ")}`);
        }
    } else if (input.timeInForce !== undefined && input.timeInForce !== null && input.timeInForce !== "" && !TIME_IN_FORCE.includes(timeInForce)) {
        errors.push(`timeInForce must be one of ${TIME_IN_FORCE.join(", ")}`);
    }

    if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
        errors.push("metadata must be an object when provided");
    }

    return errors;
}

export function buildOrderSubmitStreamEntry(input) {
    const command = normalizeOrderSubmitCommand(input);
    const errors = validateOrderSubmitCommand(command);

    if (errors.length > 0) {
        throw new Error(`Invalid order submit command: ${errors.join("; ")}`);
    }

    return omitEmptyFields({
        schemaVersion: command.schemaVersion,
        messageType: command.messageType,
        commandId: command.commandId,
        orderId: command.orderId,
        userId: command.userId,
        symbol: command.symbol,
        side: command.side,
        orderType: command.orderType,
        quantity: command.quantity,
        quoteOrderQty: command.quoteOrderQty,
        price: command.price,
        stopPrice: command.stopPrice,
        timeInForce: command.timeInForce,
        requestId: command.requestId,
        source: command.source,
        createdAt: command.createdAt,
        metadata: JSON.stringify(command.metadata),
    });
}

export function parseOrderSubmitStreamEntry(fields) {
    if (!isPlainObject(fields)) {
        throw new Error("Redis stream entry fields must be an object");
    }

    const metadata = parseStreamMetadata(fields);

    const command = normalizeOrderSubmitCommand({
        ...fields,
        metadata,
    });
    const errors = validateOrderSubmitCommand(command);

    if (errors.length > 0) {
        throw new Error(`Invalid order submit stream entry: ${errors.join("; ")}`);
    }

    return command;
}

export function validateOrderCancelCommand(input) {
    const errors = [];

    if (!isPlainObject(input)) {
        return ["command must be an object"];
    }

    const schemaVersion = optionalString(input.schemaVersion) || STREAM_CONTRACT_VERSION;
    const messageType = optionalString(input.messageType) || ORDER_COMMAND_TYPES.cancel;

    if (schemaVersion !== STREAM_CONTRACT_VERSION) {
        errors.push(`schemaVersion must be ${STREAM_CONTRACT_VERSION}`);
    }

    if (messageType !== ORDER_COMMAND_TYPES.cancel) {
        errors.push(`messageType must be ${ORDER_COMMAND_TYPES.cancel}`);
    }

    requireNonEmptyString(input.commandId, "commandId", errors);
    requireNonEmptyString(input.orderId, "orderId", errors);
    requireNonEmptyString(input.userId, "userId", errors);
    requireNonEmptyString(input.symbol, "symbol", errors);
    requireNonEmptyString(input.createdAt, "createdAt", errors);

    if (typeof input.createdAt === "string" && Number.isNaN(Date.parse(input.createdAt))) {
        errors.push("createdAt must be an ISO-compatible timestamp");
    }

    if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
        errors.push("metadata must be an object when provided");
    }

    return errors;
}

export function buildOrderCancelStreamEntry(input) {
    const command = normalizeOrderCancelCommand(input);
    const errors = validateOrderCancelCommand(command);

    if (errors.length > 0) {
        throw new Error(`Invalid order cancel command: ${errors.join("; ")}`);
    }

    return omitEmptyFields({
        schemaVersion: command.schemaVersion,
        messageType: command.messageType,
        commandId: command.commandId,
        orderId: command.orderId,
        userId: command.userId,
        symbol: command.symbol,
        requestId: command.requestId,
        source: command.source,
        createdAt: command.createdAt,
        metadata: JSON.stringify(command.metadata),
    });
}

export function parseOrderCancelStreamEntry(fields) {
    if (!isPlainObject(fields)) {
        throw new Error("Redis stream entry fields must be an object");
    }

    const metadata = parseStreamMetadata(fields);
    const command = normalizeOrderCancelCommand({
        ...fields,
        metadata,
    });
    const errors = validateOrderCancelCommand(command);

    if (errors.length > 0) {
        throw new Error(`Invalid order cancel stream entry: ${errors.join("; ")}`);
    }

    return command;
}

export function validateOrderCancelAllCommand(input) {
    const errors = [];

    if (!isPlainObject(input)) {
        return ["command must be an object"];
    }

    const schemaVersion = optionalString(input.schemaVersion) || STREAM_CONTRACT_VERSION;
    const messageType = optionalString(input.messageType) || ORDER_COMMAND_TYPES.cancelAll;

    if (schemaVersion !== STREAM_CONTRACT_VERSION) {
        errors.push(`schemaVersion must be ${STREAM_CONTRACT_VERSION}`);
    }

    if (messageType !== ORDER_COMMAND_TYPES.cancelAll) {
        errors.push(`messageType must be ${ORDER_COMMAND_TYPES.cancelAll}`);
    }

    requireNonEmptyString(input.commandId, "commandId", errors);
    requireNonEmptyString(input.userId, "userId", errors);
    requireNonEmptyString(input.symbol, "symbol", errors);
    requireNonEmptyString(input.createdAt, "createdAt", errors);

    if (typeof input.createdAt === "string" && Number.isNaN(Date.parse(input.createdAt))) {
        errors.push("createdAt must be an ISO-compatible timestamp");
    }

    if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
        errors.push("metadata must be an object when provided");
    }

    return errors;
}

export function buildOrderCancelAllStreamEntry(input) {
    const command = normalizeOrderCancelAllCommand(input);
    const errors = validateOrderCancelAllCommand(command);

    if (errors.length > 0) {
        throw new Error(`Invalid order cancel-all command: ${errors.join("; ")}`);
    }

    return omitEmptyFields({
        schemaVersion: command.schemaVersion,
        messageType: command.messageType,
        commandId: command.commandId,
        userId: command.userId,
        symbol: command.symbol,
        requestId: command.requestId,
        source: command.source,
        createdAt: command.createdAt,
        metadata: JSON.stringify(command.metadata),
    });
}

export function parseOrderCancelAllStreamEntry(fields) {
    if (!isPlainObject(fields)) {
        throw new Error("Redis stream entry fields must be an object");
    }

    const metadata = parseStreamMetadata(fields);
    const command = normalizeOrderCancelAllCommand({
        ...fields,
        metadata,
    });
    const errors = validateOrderCancelAllCommand(command);

    if (errors.length > 0) {
        throw new Error(`Invalid order cancel-all stream entry: ${errors.join("; ")}`);
    }

    return command;
}

export function parseOrderCommandStreamEntry(fields) {
    if (!isPlainObject(fields)) {
        throw new Error("Redis stream entry fields must be an object");
    }

    const messageType = optionalString(fields.messageType) || ORDER_COMMAND_TYPES.submit;

    if (messageType === ORDER_COMMAND_TYPES.submit) {
        return parseOrderSubmitStreamEntry(fields);
    }

    if (messageType === ORDER_COMMAND_TYPES.cancel) {
        return parseOrderCancelStreamEntry(fields);
    }

    if (messageType === ORDER_COMMAND_TYPES.cancelAll) {
        return parseOrderCancelAllStreamEntry(fields);
    }

    throw new Error(`Unsupported order command messageType: ${messageType}`);
}

export function buildOrderCommandDeadLetterEntry({
    originalStreamId,
    reason,
    command,
    attempts = 0,
    failedAt = new Date().toISOString(),
} = {}) {
    if (!isNonEmptyString(originalStreamId)) {
        throw new Error("originalStreamId is required");
    }

    if (!isNonEmptyString(reason)) {
        throw new Error("reason is required");
    }

    if (!isPlainObject(command)) {
        throw new Error("command must be an object");
    }

    if (!Number.isInteger(Number(attempts)) || Number(attempts) < 0) {
        throw new Error("attempts must be a non-negative integer");
    }

    if (!isNonEmptyString(failedAt) || Number.isNaN(Date.parse(failedAt))) {
        throw new Error("failedAt must be an ISO-compatible timestamp");
    }

    return omitEmptyFields({
        schemaVersion: STREAM_CONTRACT_VERSION,
        messageType: ORDER_EVENT_TYPES.deadLettered,
        originalStreamId,
        commandId: command.commandId,
        orderId: command.orderId,
        userId: command.userId,
        reason,
        attempts: String(attempts),
        failedAt,
        payload: JSON.stringify(command),
    });
}

function normalizeOrderSubmitCommand(input) {
    if (!isPlainObject(input)) {
        return input;
    }

    return omitUndefinedFields({
        schemaVersion: optionalString(input.schemaVersion) || STREAM_CONTRACT_VERSION,
        messageType: optionalString(input.messageType) || ORDER_COMMAND_TYPES.submit,
        commandId: optionalString(input.commandId),
        orderId: optionalString(input.orderId),
        userId: optionalString(input.userId),
        symbol: normalizeToken(input.symbol),
        side: normalizeToken(input.side),
        orderType: normalizeToken(input.orderType),
        quantity: optionalString(input.quantity),
        quoteOrderQty: optionalString(input.quoteOrderQty),
        price: optionalString(input.price),
        stopPrice: optionalString(input.stopPrice),
        timeInForce: normalizeToken(input.timeInForce),
        requestId: optionalString(input.requestId),
        source: optionalString(input.source) || "backend",
        createdAt: optionalString(input.createdAt) || new Date().toISOString(),
        metadata: input.metadata === undefined || input.metadata === null ? {} : input.metadata,
    });
}

function normalizeOrderCancelCommand(input) {
    if (!isPlainObject(input)) {
        return input;
    }

    return omitUndefinedFields({
        schemaVersion: optionalString(input.schemaVersion) || STREAM_CONTRACT_VERSION,
        messageType: optionalString(input.messageType) || ORDER_COMMAND_TYPES.cancel,
        commandId: optionalString(input.commandId),
        orderId: optionalString(input.orderId),
        userId: optionalString(input.userId),
        symbol: normalizeToken(input.symbol),
        requestId: optionalString(input.requestId),
        source: optionalString(input.source) || "backend",
        createdAt: optionalString(input.createdAt) || new Date().toISOString(),
        metadata: input.metadata === undefined || input.metadata === null ? {} : input.metadata,
    });
}

function normalizeOrderCancelAllCommand(input) {
    if (!isPlainObject(input)) {
        return input;
    }

    return omitUndefinedFields({
        schemaVersion: optionalString(input.schemaVersion) || STREAM_CONTRACT_VERSION,
        messageType: optionalString(input.messageType) || ORDER_COMMAND_TYPES.cancelAll,
        commandId: optionalString(input.commandId),
        userId: optionalString(input.userId),
        symbol: normalizeToken(input.symbol),
        requestId: optionalString(input.requestId),
        source: optionalString(input.source) || "backend",
        createdAt: optionalString(input.createdAt) || new Date().toISOString(),
        metadata: input.metadata === undefined || input.metadata === null ? {} : input.metadata,
    });
}

function parseStreamMetadata(fields) {
    if (fields.metadata === undefined || fields.metadata === "") {
        return {};
    }

    try {
        return JSON.parse(fields.metadata);
    } catch {
        throw new Error("Redis stream entry metadata must be valid JSON");
    }
}

function readOptionalEnv(env, name) {
    const value = env?.[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readPositiveInteger(env, name, fallback) {
    const rawValue = readOptionalEnv(env, name);

    if (rawValue === undefined) {
        return fallback;
    }

    const value = Number(rawValue);

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }

    return value;
}

function requireNonEmptyString(value, fieldName, errors) {
    if (!isNonEmptyString(value)) {
        errors.push(`${fieldName} is required`);
    }
}

function requireDecimalString(value, fieldName, errors) {
    if (!isValidPositiveDecimalString(value)) {
        errors.push(`${fieldName} must be a positive decimal string`);
    }
}

function requireOptionalDecimalString(value, fieldName, errors) {
    if (value === undefined || value === null || value === "") {
        return;
    }

    requireDecimalString(value, fieldName, errors);
}

function isValidPositiveDecimalString(value) {
    return typeof value === "string" && DECIMAL_STRING_PATTERN.test(value) && /[1-9]/.test(value);
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}

function optionalString(value) {
    return typeof value === "string" ? value.trim() : undefined;
}

function normalizeToken(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

function omitUndefinedFields(input) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function omitEmptyFields(input) {
    return Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    );
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
