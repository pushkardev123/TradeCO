export const REALTIME_CHANNELS = Object.freeze({
    orders: "events:order:status",
    prices: "events:price:update",
    balances: "events:account:balances",
    chartsRequest: "events:chart:request",
    charts: "events:chart:update",
    accountRequest: "events:account:request",
    accountResponse: "events:account:response",
    symbolRequest: "events:symbol:request",
    symbolResponse: "events:symbol:response",
});

export const SCOPED_REALTIME_CHANNELS = Object.freeze([
    REALTIME_CHANNELS.orders,
    REALTIME_CHANNELS.balances,
    REALTIME_CHANNELS.accountResponse,
]);

export const REALTIME_EVENT_TYPES = Object.freeze({
    redisEnvelope: "REDIS_EVENT",
    accountBalances: "ACCOUNT_BALANCES",
    accountInfoRequest: "ACCOUNT_INFO_REQUEST",
    accountInfoResponse: "ACCOUNT_INFO_RESPONSE",
    symbolInfoRequest: "SYMBOL_INFO_REQUEST",
    symbolInfoResponse: "SYMBOL_INFO_RESPONSE",
    priceUpdate: "PRICE_UPDATE",
    marketBoard: "MARKET_BOARD",
    klineSnapshot: "KLINE_SNAPSHOT",
    klineUpdate: "KLINE_UPDATE",
    chartSubscribe: "CHART_SUBSCRIBE",
    chartUnsubscribe: "CHART_UNSUBSCRIBE",
});

const ORDER_STATUSES = new Set([
    "RECEIVED",
    "PENDING",
    "SUBMITTED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCELED",
    "REJECTED",
    "EXPIRED",
    "CANCEL_REQUESTED",
    "CANCEL_PENDING",
    "CANCEL_REJECTED",
    "CANCEL_APPEND_FAILED",
    "STREAM_APPEND_FAILED",
]);
const SIDES = new Set(["BUY", "SELL"]);
const DECIMAL_STRING_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function validateRealtimeChannelPayload(channel, payload, options = {}) {
    const errors = [];
    const channels = getRealtimeChannelConfigFromOptions(options);
    const channelRole = getChannelRole(channel, channels);
    const scopedChannels = getScopedChannels(channels);

    if (!isPlainObject(payload)) {
        return ["payload must be an object"];
    }

    if (scopedChannels.includes(channel)) {
        requireNonEmptyString(payload.userId, "userId", errors);
    }

    switch (channelRole) {
        case "orders":
            validateOrderStatusEvent(payload, errors);
            break;
        case "balances":
            validateAccountBalancesEvent(payload, errors);
            break;
        case "accountRequest":
            validateAccountInfoRequest(payload, errors, channels);
            break;
        case "accountResponse":
            validateAccountInfoResponse(payload, errors);
            break;
        case "symbolRequest":
            validateSymbolInfoRequest(payload, errors, channels);
            break;
        case "symbolResponse":
            validateSymbolInfoResponse(payload, errors);
            break;
        case "prices":
            validatePriceEvent(payload, errors);
            break;
        case "chartsRequest":
            validateChartRequest(payload, errors);
            break;
        case "charts":
            validateChartEvent(payload, errors);
            break;
        default:
            errors.push(`unsupported realtime channel: ${channel || "<empty>"}`);
    }

    return errors;
}

export function assertRealtimeChannelPayload(channel, payload, options = {}) {
    const errors = validateRealtimeChannelPayload(channel, payload, options);
    if (errors.length > 0) {
        throw new Error(errors.join("; "));
    }
    return true;
}

export function validateWebSocketRedisEnvelope(envelope, options = {}) {
    const errors = [];
    const channels = getRealtimeChannelConfigFromOptions(options);
    if (!isPlainObject(envelope)) return ["envelope must be an object"];
    if (envelope.type !== REALTIME_EVENT_TYPES.redisEnvelope) errors.push(`type must be ${REALTIME_EVENT_TYPES.redisEnvelope}`);
    if (!Object.values(channels).includes(envelope.channel)) errors.push("channel must be a known realtime channel");
    if (typeof envelope.message !== "string") errors.push("message must be a JSON string");
    if (!isFiniteNumber(envelope.ts)) errors.push("ts must be a number");

    if (typeof envelope.message === "string" && Object.values(channels).includes(envelope.channel)) {
        try {
            const inner = JSON.parse(envelope.message);
            errors.push(...validateRealtimeChannelPayload(envelope.channel, inner, { channels }).map((error) => `message.${error}`));
        } catch {
            errors.push("message must parse as JSON");
        }
    }

    return errors;
}

export function getRealtimeChannelConfig(env = process.env) {
    return Object.freeze({
        orders: readOptionalEnv(env, "EVENTS_CHANNEL") || REALTIME_CHANNELS.orders,
        prices: readOptionalEnv(env, "PRICES_CHANNEL") || REALTIME_CHANNELS.prices,
        balances: readOptionalEnv(env, "BALANCES_CHANNEL") || REALTIME_CHANNELS.balances,
        chartsRequest: readOptionalEnv(env, "CHART_REQ_CHANNEL") || REALTIME_CHANNELS.chartsRequest,
        charts: readOptionalEnv(env, "CHARTS_CHANNEL") || REALTIME_CHANNELS.charts,
        accountRequest: readOptionalEnv(env, "ACCOUNT_REQ_CHANNEL") || REALTIME_CHANNELS.accountRequest,
        accountResponse: readOptionalEnv(env, "ACCOUNT_RES_CHANNEL") || REALTIME_CHANNELS.accountResponse,
        symbolRequest: readOptionalEnv(env, "SYMBOL_REQ_CHANNEL") || REALTIME_CHANNELS.symbolRequest,
        symbolResponse: readOptionalEnv(env, "SYMBOL_RES_CHANNEL") || REALTIME_CHANNELS.symbolResponse,
    });
}

function validateOrderStatusEvent(payload, errors) {
    requireNonEmptyString(payload.orderId, "orderId", errors);
    requireNonEmptyString(payload.symbol, "symbol", errors);
    requireNonEmptyString(payload.orderType, "orderType", errors);
    requireOneOf(payload.status, ORDER_STATUSES, "status", errors);
    requireOneOf(payload.side, SIDES, "side", errors);
    requireNullableDecimalString(payload.quantity, "quantity", errors);
    requireNullableDecimalString(payload.price, "price", errors);
    requireIsoTimestamp(payload.timestamp, "timestamp", errors);

    if (payload.binance !== undefined && payload.binance !== null && !isPlainObject(payload.binance)) {
        errors.push("binance must be an object when present");
    }
}

function validateAccountBalancesEvent(payload, errors) {
    if (payload.type !== REALTIME_EVENT_TYPES.accountBalances) errors.push(`type must be ${REALTIME_EVENT_TYPES.accountBalances}`);
    requireFiniteNumber(payload.ts, "ts", errors);
    if (!Array.isArray(payload.balances)) {
        errors.push("balances must be an array");
        return;
    }

    payload.balances.forEach((balance, index) => {
        if (!isPlainObject(balance)) {
            errors.push(`balances[${index}] must be an object`);
            return;
        }
        requireNonEmptyString(balance.asset, `balances[${index}].asset`, errors);
        requireDecimalString(balance.free, `balances[${index}].free`, errors);
        requireDecimalString(balance.locked, `balances[${index}].locked`, errors);
    });
}

function validateAccountInfoRequest(payload, errors, channels) {
    if (payload.type !== REALTIME_EVENT_TYPES.accountInfoRequest) errors.push(`type must be ${REALTIME_EVENT_TYPES.accountInfoRequest}`);
    requireNonEmptyString(payload.id, "id", errors);
    requireNonEmptyString(payload.userId, "userId", errors);
    if (payload.replyTo !== undefined && payload.replyTo !== channels.accountResponse) {
        errors.push(`replyTo must be ${channels.accountResponse}`);
    }
    if (payload.pinnedAssets !== undefined && !Array.isArray(payload.pinnedAssets)) {
        errors.push("pinnedAssets must be an array when present");
    }
}

function validateAccountInfoResponse(payload, errors) {
    if (payload.type !== REALTIME_EVENT_TYPES.accountInfoResponse) errors.push(`type must be ${REALTIME_EVENT_TYPES.accountInfoResponse}`);
    requireNonEmptyString(payload.id, "id", errors);
    requireNonEmptyString(payload.userId, "userId", errors);
    requireBoolean(payload.ok, "ok", errors);
    if (payload.ok === true && !isPlainObject(payload.data)) errors.push("data must be an object when ok is true");
    if (payload.ok === false) requireNonEmptyString(payload.error, "error", errors);
}

function validateSymbolInfoRequest(payload, errors, channels) {
    if (payload.type !== REALTIME_EVENT_TYPES.symbolInfoRequest) errors.push(`type must be ${REALTIME_EVENT_TYPES.symbolInfoRequest}`);
    requireNonEmptyString(payload.id, "id", errors);
    requireNonEmptyString(payload.symbol, "symbol", errors);
    if (payload.replyTo !== undefined && payload.replyTo !== channels.symbolResponse) {
        errors.push(`replyTo must be ${channels.symbolResponse}`);
    }
}

function validateSymbolInfoResponse(payload, errors) {
    if (payload.type !== REALTIME_EVENT_TYPES.symbolInfoResponse) errors.push(`type must be ${REALTIME_EVENT_TYPES.symbolInfoResponse}`);
    requireNonEmptyString(payload.id, "id", errors);
    requireNonEmptyString(payload.symbol, "symbol", errors);
    requireBoolean(payload.ok, "ok", errors);
    if (payload.ok === true && !isPlainObject(payload.data)) errors.push("data must be an object when ok is true");
    if (payload.ok === false) requireNonEmptyString(payload.error, "error", errors);
}

function validatePriceEvent(payload, errors) {
    if (payload.type === REALTIME_EVENT_TYPES.priceUpdate) {
        requireNonEmptyString(payload.symbol, "symbol", errors);
        requireFiniteNumber(payload.price, "price", errors);
        requireFiniteNumber(payload.ts, "ts", errors);
        return;
    }

    if (payload.type === REALTIME_EVENT_TYPES.marketBoard) {
        requireFiniteNumber(payload.ts, "ts", errors);
        if (!Array.isArray(payload.data)) {
            errors.push("data must be an array");
            return;
        }
        payload.data.forEach((ticker, index) => {
            if (!isPlainObject(ticker)) {
                errors.push(`data[${index}] must be an object`);
                return;
            }
            requireNonEmptyString(ticker.symbol, `data[${index}].symbol`, errors);
            requireFiniteNumber(ticker.price, `data[${index}].price`, errors);
        });
        return;
    }

    errors.push(`type must be ${REALTIME_EVENT_TYPES.priceUpdate} or ${REALTIME_EVENT_TYPES.marketBoard}`);
}

function validateChartRequest(payload, errors) {
    if (payload.type !== REALTIME_EVENT_TYPES.chartSubscribe && payload.type !== REALTIME_EVENT_TYPES.chartUnsubscribe) {
        errors.push(`type must be ${REALTIME_EVENT_TYPES.chartSubscribe} or ${REALTIME_EVENT_TYPES.chartUnsubscribe}`);
    }
    requireNonEmptyString(payload.id, "id", errors);
    requireNonEmptyString(payload.symbol, "symbol", errors);
    requireNonEmptyString(payload.interval, "interval", errors);
}

function validateChartEvent(payload, errors) {
    if (payload.type === REALTIME_EVENT_TYPES.klineSnapshot) {
        requireNonEmptyString(payload.symbol, "symbol", errors);
        requireNonEmptyString(payload.interval, "interval", errors);
        requireFiniteNumber(payload.ts, "ts", errors);
        if (!Array.isArray(payload.candles)) {
            errors.push("candles must be an array");
            return;
        }
        return;
    }

    if (payload.type === REALTIME_EVENT_TYPES.klineUpdate) {
        requireNonEmptyString(payload.symbol, "symbol", errors);
        requireNonEmptyString(payload.interval, "interval", errors);
        requireFiniteNumber(payload.ts, "ts", errors);
        if (!isPlainObject(payload.kline)) {
            errors.push("kline must be an object");
        }
        return;
    }

    errors.push(`type must be ${REALTIME_EVENT_TYPES.klineSnapshot} or ${REALTIME_EVENT_TYPES.klineUpdate}`);
}

function requireNonEmptyString(value, fieldName, errors) {
    if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${fieldName} must be a non-empty string`);
    }
}

function requireOneOf(value, allowed, fieldName, errors) {
    if (!allowed.has(String(value || "").toUpperCase())) {
        errors.push(`${fieldName} must be one of ${[...allowed].join(", ")}`);
    }
}

function requireDecimalString(value, fieldName, errors) {
    if (typeof value !== "string" || !DECIMAL_STRING_PATTERN.test(value)) {
        errors.push(`${fieldName} must be a positive decimal string`);
    }
}

function requireNullableDecimalString(value, fieldName, errors) {
    if (value === undefined || value === null) return;
    requireDecimalString(value, fieldName, errors);
}

function requireFiniteNumber(value, fieldName, errors) {
    if (!isFiniteNumber(value)) {
        errors.push(`${fieldName} must be a finite number`);
    }
}

function requireBoolean(value, fieldName, errors) {
    if (typeof value !== "boolean") {
        errors.push(`${fieldName} must be a boolean`);
    }
}

function requireIsoTimestamp(value, fieldName, errors) {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        errors.push(`${fieldName} must be an ISO-compatible timestamp`);
    }
}

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getRealtimeChannelConfigFromOptions(options = {}) {
    return options?.channels || REALTIME_CHANNELS;
}

function getChannelRole(channel, channels) {
    return Object.entries(channels).find(([, value]) => value === channel)?.[0] || null;
}

function getScopedChannels(channels) {
    return [channels.orders, channels.balances, channels.accountResponse].filter(Boolean);
}

function readOptionalEnv(env, name) {
    const value = env?.[name];
    if (value === undefined || value === null || String(value).trim() === "") return undefined;
    return String(value).trim();
}
