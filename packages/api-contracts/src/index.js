export const API_CONTRACT_VERSION = "1";

export const ORDER_API_ROUTES = Object.freeze({
    list: "/orders",
    create: "/orders",
    open: "/orders/open",
    detail: "/orders/:orderId",
    cancel: "/orders/:orderId",
    cancelAllOpen: "/orders/open",
});

export const AUTH_API_ROUTES = Object.freeze({
    register: "/auth/register",
    login: "/auth/login",
    refresh: "/auth/refresh",
    logout: "/auth/logout",
    me: "/auth/me",
});

export const POSITION_API_ROUTES = Object.freeze({
    list: "/positions",
});

export const DEFAULT_REALTIME_CHANNELS = Object.freeze({
    orders: "events:order:status",
    prices: "events:price:update",
    balances: "events:account:balances",
    charts: "events:chart:update",
    accountRequest: "events:account:request",
    accountResponse: "events:account:response",
    symbolRequest: "events:symbol:request",
    symbolResponse: "events:symbol:response",
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

export const BASIC_ORDER_TYPES = Object.freeze(["LIMIT", "MARKET", "STOP_LOSS"]);

export const TIME_IN_FORCE = Object.freeze(["GTC", "IOC", "FOK"]);

export const ORDER_STATUSES = Object.freeze([
    "RECEIVED",
    "PENDING",
    "SUBMITTED",
    "NEW",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCELED",
    "CANCELLED",
    "EXPIRED",
    "REJECTED",
    "CANCEL_REQUESTED",
    "CANCEL_PENDING",
    "PENDING_CANCEL",
    "CANCEL_REJECTED",
    "CANCEL_APPEND_FAILED",
    "STREAM_APPEND_FAILED",
]);

export const OPEN_ORDER_STATUSES = Object.freeze([
    "RECEIVED",
    "PENDING",
    "SUBMITTED",
    "NEW",
    "PARTIALLY_FILLED",
    "CANCEL_REQUESTED",
    "CANCEL_PENDING",
    "CANCEL_REJECTED",
    "CANCEL_APPEND_FAILED",
]);

export const CANCEL_IN_FLIGHT_STATUSES = Object.freeze(["CANCEL_REQUESTED", "CANCEL_PENDING"]);

export const DECIMAL_STRING_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function toDecimalBoundaryString(value) {
    if (value === undefined || value === null) return null;
    return String(value);
}

export function toTimestampBoundaryString(value) {
    return value?.toISOString?.() || value || null;
}

export function formatOrderEventDto(event) {
    return {
        id: event.id,
        orderId: event.orderId,
        status: event.status,
        price: toDecimalBoundaryString(event.price),
        quantity: toDecimalBoundaryString(event.quantity),
        timestamp: toTimestampBoundaryString(event.timestamp),
        createdAt: toTimestampBoundaryString(event.createdAt),
    };
}

export function formatOrderCommandDto(command, latest = null) {
    return {
        orderId: command.orderId,
        symbol: command.symbol,
        side: command.side,
        orderType: command.type || command.orderType,
        quantity: toDecimalBoundaryString(command.quantity),
        price: toDecimalBoundaryString(command.price),
        stopPrice: toDecimalBoundaryString(command.stopPrice),
        timeInForce: command.timeInForce || null,
        status: latest?.status || command.status,
        rawStatus: command.rawStatus || null,
        executedQty: toDecimalBoundaryString(command.executedQty),
        cummulativeQuoteQty: toDecimalBoundaryString(command.cummulativeQuoteQty),
        avgFillPrice: toDecimalBoundaryString(command.avgFillPrice),
        lastTradeQty: toDecimalBoundaryString(command.lastTradeQty),
        lastTradePrice: toDecimalBoundaryString(command.lastTradePrice),
        binanceOrderId: toDecimalBoundaryString(command.binanceOrderId),
        errorCode: command.errorCode || null,
        errorMsg: command.errorMsg || null,
        submittedAt: toTimestampBoundaryString(command.submittedAt),
        lastExchangeUpdateAt: toTimestampBoundaryString(command.lastExchangeUpdateAt),
        timestamp: toTimestampBoundaryString(latest?.timestamp || command.updatedAt || command.createdAt),
        createdAt: toTimestampBoundaryString(command.createdAt),
        updatedAt: toTimestampBoundaryString(command.updatedAt),
    };
}

export function formatPositionDto(position) {
    return {
        id: position.id,
        symbol: position.symbol,
        quantity: toDecimalBoundaryString(position.quantity),
        avgPrice: toDecimalBoundaryString(position.avgPrice),
        realizedPnl: toDecimalBoundaryString(position.realizedPnl),
        updatedAt: toTimestampBoundaryString(position.updatedAt),
        createdAt: toTimestampBoundaryString(position.createdAt),
    };
}

export function validateOrderDto(order) {
    const errors = [];
    if (!isPlainObject(order)) return ["order must be an object"];

    requireNonEmptyString(order.orderId, "order.orderId", errors);
    requireNonEmptyString(order.symbol, "order.symbol", errors);
    requireOneOf(order.side, ORDER_SIDES, "order.side", errors);
    requireOneOf(order.orderType, ORDER_TYPES, "order.orderType", errors);
    requireOneOf(order.status, ORDER_STATUSES, "order.status", errors);
    requireNullableDecimalString(order.quantity, "order.quantity", errors);
    requireNullableDecimalString(order.price, "order.price", errors);
    requireNullableDecimalString(order.stopPrice, "order.stopPrice", errors);
    requireNullableDecimalString(order.executedQty, "order.executedQty", errors);
    requireNullableDecimalString(order.cummulativeQuoteQty, "order.cummulativeQuoteQty", errors);
    requireNullableDecimalString(order.avgFillPrice, "order.avgFillPrice", errors);
    requireNullableDecimalString(order.lastTradeQty, "order.lastTradeQty", errors);
    requireNullableDecimalString(order.lastTradePrice, "order.lastTradePrice", errors);

    return errors;
}

export function validateOrdersPageResponse(response) {
    const errors = validateOkEnvelope(response, "orders response");
    if (errors.length > 0) return errors;

    if (!Array.isArray(response.items)) {
        errors.push("orders response.items must be an array");
    } else {
        response.items.forEach((item, index) => {
            errors.push(...validateOrderDto(item).map((error) => `items[${index}].${error}`));
        });
    }

    requireNullableString(response.nextCursor, "orders response.nextCursor", errors);
    requireOptionalFiniteNumber(response.totalEntries, "orders response.totalEntries", errors);
    requireOptionalFiniteNumber(response.totalPages, "orders response.totalPages", errors);
    return errors;
}

export function validateOpenOrdersResponse(response) {
    const errors = validateOkEnvelope(response, "open orders response");
    if (errors.length > 0) return errors;

    if (!Array.isArray(response.items)) {
        errors.push("open orders response.items must be an array");
    } else {
        response.items.forEach((item, index) => {
            errors.push(...validateOrderDto(item).map((error) => `items[${index}].${error}`));
        });
    }

    requireOptionalFiniteNumber(response.count, "open orders response.count", errors);
    requireNullableString(response.symbol, "open orders response.symbol", errors);
    return errors;
}

export function validateOrderDetailResponse(response) {
    const errors = validateOkEnvelope(response, "order detail response");
    if (errors.length > 0) return errors;

    errors.push(...validateOrderDto(response.order).map((error) => `order.${error}`));
    if (!Array.isArray(response.events)) {
        errors.push("order detail response.events must be an array");
    }

    return errors;
}

export function validatePositionDto(position) {
    const errors = [];
    if (!isPlainObject(position)) return ["position must be an object"];

    requireNonEmptyString(position.id, "position.id", errors);
    requireNonEmptyString(position.symbol, "position.symbol", errors);
    requireNullableDecimalString(position.quantity, "position.quantity", errors);
    requireNullableDecimalString(position.avgPrice, "position.avgPrice", errors);
    requireNullableDecimalString(position.realizedPnl, "position.realizedPnl", errors);
    return errors;
}

export function validatePositionsPageResponse(response) {
    const errors = validateOkEnvelope(response, "positions response");
    if (errors.length > 0) return errors;

    if (!Array.isArray(response.items)) {
        errors.push("positions response.items must be an array");
    } else {
        response.items.forEach((item, index) => {
            errors.push(...validatePositionDto(item).map((error) => `items[${index}].${error}`));
        });
    }

    requireNullableString(response.nextCursor, "positions response.nextCursor", errors);
    requireOptionalFiniteNumber(response.totalEntries, "positions response.totalEntries", errors);
    requireOptionalFiniteNumber(response.totalPages, "positions response.totalPages", errors);
    return errors;
}

export function validateBalanceDto(balance) {
    const errors = [];
    if (!isPlainObject(balance)) return ["balance must be an object"];

    requireNonEmptyString(balance.asset, "balance.asset", errors);
    requireDecimalString(balance.free, "balance.free", errors);
    requireDecimalString(balance.locked, "balance.locked", errors);
    return errors;
}

export function validateAccountBalancesPayload(payload) {
    const errors = [];
    if (!isPlainObject(payload)) return ["account balances payload must be an object"];

    if (!Array.isArray(payload.balances)) {
        errors.push("account balances payload.balances must be an array");
    } else {
        payload.balances.forEach((balance, index) => {
            errors.push(...validateBalanceDto(balance).map((error) => `balances[${index}].${error}`));
        });
    }

    return errors;
}

export function validateAuthContextResponse(response) {
    const errors = validateOkEnvelope(response, "auth context response");
    if (errors.length > 0) return errors;
    if (!isPlainObject(response.user)) {
        errors.push("auth context response.user must be an object");
    } else {
        requireNonEmptyString(response.user.id, "auth context response.user.id", errors);
        requireNonEmptyString(response.user.email, "auth context response.user.email", errors);
    }
    return errors;
}

export function assertContract(name, value, validator) {
    const errors = validator(value);
    if (errors.length > 0) {
        throw new Error(`${name} contract failed: ${errors.join("; ")}`);
    }
    return value;
}

function validateOkEnvelope(response, label) {
    if (!isPlainObject(response)) return [`${label} must be an object`];
    if (response.ok !== true) return [`${label}.ok must be true`];
    return [];
}

function requireNonEmptyString(value, fieldName, errors) {
    if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${fieldName} is required`);
    }
}

function requireNullableString(value, fieldName, errors) {
    if (value === undefined || value === null) return;
    if (typeof value !== "string") errors.push(`${fieldName} must be a string or null`);
}

function requireOneOf(value, allowedValues, fieldName, errors) {
    if (!allowedValues.includes(value)) {
        errors.push(`${fieldName} must be one of ${allowedValues.join(", ")}`);
    }
}

function requireDecimalString(value, fieldName, errors) {
    if (typeof value !== "string" || !DECIMAL_STRING_PATTERN.test(value)) {
        errors.push(`${fieldName} must be a decimal string`);
    }
}

function requireNullableDecimalString(value, fieldName, errors) {
    if (value === undefined || value === null || value === "") return;
    requireDecimalString(value, fieldName, errors);
}

function requireOptionalFiniteNumber(value, fieldName, errors) {
    if (value === undefined || value === null) return;
    if (!Number.isFinite(Number(value))) errors.push(`${fieldName} must be a finite number`);
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
