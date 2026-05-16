export const BINANCE_FILTER_TYPES = Object.freeze({
    price: "PRICE_FILTER",
    lotSize: "LOT_SIZE",
    marketLotSize: "MARKET_LOT_SIZE",
    minNotional: "MIN_NOTIONAL",
    notional: "NOTIONAL",
    maxNumOrders: "MAX_NUM_ORDERS",
    maxNumAlgoOrders: "MAX_NUM_ALGO_ORDERS",
    maxPosition: "MAX_POSITION",
});

const LIMIT_PRICE_ORDER_TYPES = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT", "LIMIT_MAKER"]);
const STOP_PRICE_ORDER_TYPES = new Set(["STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT"]);
const MARKET_NOTIONAL_ORDER_TYPES = new Set(["MARKET", "STOP_LOSS", "TAKE_PROFIT"]);
const QUOTE_ORDER_QTY_ORDER_TYPES = new Set(["MARKET"]);
const ORDER_TYPE_ALIASES = Object.freeze({
    STOP_MARKET: "STOP_LOSS",
});

export function normalizeBinanceSymbolFilters(symbolInfo = {}) {
    const filters = Array.isArray(symbolInfo?.filters) ? symbolInfo.filters : [];
    const byType = new Map(filters.map((filter) => [String(filter?.filterType || "").toUpperCase(), filter]));

    return {
        symbol: optionalString(symbolInfo.symbol)?.toUpperCase() || null,
        baseAsset: optionalString(symbolInfo.baseAsset)?.toUpperCase() || null,
        quoteAsset: optionalString(symbolInfo.quoteAsset)?.toUpperCase() || null,
        priceFilter: normalizePriceFilter(byType.get(BINANCE_FILTER_TYPES.price) || symbolInfo),
        lotSize: normalizeQuantityFilter(byType.get(BINANCE_FILTER_TYPES.lotSize) || symbolInfo, BINANCE_FILTER_TYPES.lotSize),
        marketLotSize: normalizeQuantityFilter(byType.get(BINANCE_FILTER_TYPES.marketLotSize), BINANCE_FILTER_TYPES.marketLotSize),
        minNotional: normalizeMinNotionalFilter(byType.get(BINANCE_FILTER_TYPES.minNotional) || symbolInfo),
        notional: normalizeNotionalFilter(byType.get(BINANCE_FILTER_TYPES.notional) || symbolInfo),
        maxNumOrders: normalizeIntegerFilter(byType.get(BINANCE_FILTER_TYPES.maxNumOrders), "maxNumOrders"),
        maxNumAlgoOrders: normalizeIntegerFilter(byType.get(BINANCE_FILTER_TYPES.maxNumAlgoOrders), "maxNumAlgoOrders"),
        maxPosition: normalizeMaxPositionFilter(byType.get(BINANCE_FILTER_TYPES.maxPosition)),
    };
}

export function validateOrderAgainstExchangeFilters(order = {}, symbolInfo = {}, context = {}) {
    const errors = [];
    const filters = normalizeBinanceSymbolFilters(symbolInfo);
    const normalizedOrder = normalizeOrder(order);

    if (!normalizedOrder.symbol) {
        pushError(errors, "symbol", "SYMBOL_REQUIRED", "symbol is required");
    } else if (filters.symbol && normalizedOrder.symbol !== filters.symbol) {
        pushError(errors, "symbol", "SYMBOL_MISMATCH", `symbol must match ${filters.symbol}`);
    }

    if (!normalizedOrder.quantity && !normalizedOrder.quoteOrderQty) {
        pushError(errors, "quantity", "QUANTITY_REQUIRED", "quantity or quoteOrderQty is required");
    }

    if (normalizedOrder.quantity && normalizedOrder.quoteOrderQty) {
        pushError(errors, "quoteOrderQty", "QUOTE_ORDER_QTY_EXCLUSIVE", "quantity and quoteOrderQty are mutually exclusive");
    }

    if (normalizedOrder.quoteOrderQty && !QUOTE_ORDER_QTY_ORDER_TYPES.has(normalizedOrder.orderType)) {
        pushError(errors, "quoteOrderQty", "QUOTE_ORDER_QTY_UNSUPPORTED", "quoteOrderQty is only supported for MARKET orders");
    }

    const quantityFilter = selectQuantityFilter(normalizedOrder.orderType, filters);
    if (normalizedOrder.quantity && quantityFilter) {
        validateQuantityFilter({
            errors,
            field: "quantity",
            filter: quantityFilter,
            quantity: normalizedOrder.quantity,
        });
    }

    if (normalizedOrder.price) {
        validatePriceFilter({ errors, field: "price", filter: filters.priceFilter, value: normalizedOrder.price });
    }

    if (normalizedOrder.stopPrice) {
        validatePriceFilter({ errors, field: "stopPrice", filter: filters.priceFilter, value: normalizedOrder.stopPrice });
    }

    if (LIMIT_PRICE_ORDER_TYPES.has(normalizedOrder.orderType) && !normalizedOrder.price) {
        pushError(errors, "price", "PRICE_REQUIRED", `${normalizedOrder.orderType} requires price`);
    }

    if (STOP_PRICE_ORDER_TYPES.has(normalizedOrder.orderType) && !normalizedOrder.stopPrice) {
        pushError(errors, "stopPrice", "STOP_PRICE_REQUIRED", `${normalizedOrder.orderType} requires stopPrice`);
    }

    validateNotionalFilters({
        errors,
        order: normalizedOrder,
        filters,
        marketReferencePrice: context.marketReferencePrice || context.averagePrice || context.lastPrice,
    });

    validateOptionalRiskContext({
        errors,
        order: normalizedOrder,
        filters,
        openOrderCount: context.openOrderCount,
        openAlgoOrderCount: context.openAlgoOrderCount,
        baseAssetPositionQuantity: context.baseAssetPositionQuantity,
    });

    return {
        ok: errors.length === 0,
        errors,
        filters,
    };
}

export function formatExchangeFilterErrors(errors = []) {
    return errors.map((error) => error.message).join("; ");
}

function normalizeOrder(order) {
    const orderType = normalizeOrderType(order.orderType || order.type || "MARKET");
    return {
        symbol: optionalString(order.symbol)?.toUpperCase() || "",
        side: optionalString(order.side)?.toUpperCase() || "",
        orderType,
        quantity: positiveDecimalString(order.quantity),
        quoteOrderQty: optionalPositiveDecimalString(order.quoteOrderQty),
        price: optionalPositiveDecimalString(order.price),
        stopPrice: optionalPositiveDecimalString(order.stopPrice),
    };
}

function normalizeOrderType(value) {
    const orderType = optionalString(value)?.toUpperCase() || "MARKET";
    return ORDER_TYPE_ALIASES[orderType] || orderType;
}

function normalizePriceFilter(filter = {}) {
    return {
        filterType: BINANCE_FILTER_TYPES.price,
        minPrice: enabledDecimal(filter.minPrice),
        maxPrice: enabledDecimal(filter.maxPrice),
        tickSize: enabledDecimal(filter.tickSize),
    };
}

function normalizeQuantityFilter(filter = {}, filterType) {
    if (!filter) return null;
    const out = {
        filterType,
        minQty: enabledDecimal(filter.minQty),
        maxQty: enabledDecimal(filter.maxQty),
        stepSize: enabledDecimal(filter.stepSize),
    };
    return out.minQty || out.maxQty || out.stepSize ? out : null;
}

function normalizeMinNotionalFilter(filter = {}) {
    const minNotional = enabledDecimal(filter.minNotional);
    if (!minNotional) return null;
    return {
        filterType: BINANCE_FILTER_TYPES.minNotional,
        minNotional,
        applyToMarket: Boolean(filter.applyToMarket),
        avgPriceMins: Number.isFinite(Number(filter.avgPriceMins)) ? Number(filter.avgPriceMins) : null,
    };
}

function normalizeNotionalFilter(filter = {}) {
    const minNotional = enabledDecimal(filter.minNotional);
    const maxNotional = enabledDecimal(filter.maxNotional);
    if (!minNotional && !maxNotional) return null;
    return {
        filterType: BINANCE_FILTER_TYPES.notional,
        minNotional,
        maxNotional,
        applyMinToMarket: Boolean(filter.applyMinToMarket),
        applyMaxToMarket: Boolean(filter.applyMaxToMarket),
        avgPriceMins: Number.isFinite(Number(filter.avgPriceMins)) ? Number(filter.avgPriceMins) : null,
    };
}

function normalizeIntegerFilter(filter = {}, fieldName) {
    const value = Number(filter?.[fieldName]);
    if (!Number.isInteger(value) || value <= 0) return null;
    return { filterType: String(filter.filterType || "").toUpperCase(), [fieldName]: value };
}

function normalizeMaxPositionFilter(filter = {}) {
    const maxPosition = enabledDecimal(filter?.maxPosition);
    if (!maxPosition) return null;
    return { filterType: BINANCE_FILTER_TYPES.maxPosition, maxPosition };
}

function selectQuantityFilter(orderType, filters) {
    if (orderType === "MARKET" && filters.marketLotSize) return filters.marketLotSize;
    return filters.lotSize;
}

function validateQuantityFilter({ errors, field, filter, quantity }) {
    if (filter.minQty && compareDecimals(quantity, filter.minQty) < 0) {
        pushError(errors, field, `${filter.filterType}_MIN`, `${field} must be at least ${filter.minQty}`);
    }
    if (filter.maxQty && compareDecimals(quantity, filter.maxQty) > 0) {
        pushError(errors, field, `${filter.filterType}_MAX`, `${field} must be at most ${filter.maxQty}`);
    }
    if (filter.stepSize && !isDecimalMultiple(quantity, filter.stepSize)) {
        pushError(errors, field, `${filter.filterType}_STEP`, `${field} must align to stepSize ${filter.stepSize}`);
    }
}

function validatePriceFilter({ errors, field, filter, value }) {
    if (!filter) return;
    if (filter.minPrice && compareDecimals(value, filter.minPrice) < 0) {
        pushError(errors, field, "PRICE_FILTER_MIN", `${field} must be at least ${filter.minPrice}`);
    }
    if (filter.maxPrice && compareDecimals(value, filter.maxPrice) > 0) {
        pushError(errors, field, "PRICE_FILTER_MAX", `${field} must be at most ${filter.maxPrice}`);
    }
    if (filter.tickSize && !isDecimalMultiple(value, filter.tickSize)) {
        pushError(errors, field, "PRICE_FILTER_TICK", `${field} must align to tickSize ${filter.tickSize}`);
    }
}

function validateNotionalFilters({ errors, order, filters, marketReferencePrice }) {
    if (!order.quantity && !order.quoteOrderQty) return;

    const notional = selectNotionalValue(order, marketReferencePrice);
    if (!notional) return;
    const marketLike = MARKET_NOTIONAL_ORDER_TYPES.has(order.orderType);

    if (filters.minNotional && (!marketLike || filters.minNotional.applyToMarket)) {
        validateMinNotional(errors, notional, filters.minNotional.minNotional, BINANCE_FILTER_TYPES.minNotional);
    }

    if (filters.notional) {
        if (filters.notional.minNotional && (!marketLike || filters.notional.applyMinToMarket)) {
            validateMinNotional(errors, notional, filters.notional.minNotional, BINANCE_FILTER_TYPES.notional);
        }
        if (filters.notional.maxNotional && (!marketLike || filters.notional.applyMaxToMarket)) {
            validateMaxNotional(errors, notional, filters.notional.maxNotional, BINANCE_FILTER_TYPES.notional);
        }
    }
}

function selectNotionalValue(order, marketReferencePrice) {
    if (order.quoteOrderQty) return order.quoteOrderQty;
    const notionalPrice = selectNotionalPrice(order, marketReferencePrice);
    if (!notionalPrice || !order.quantity) return null;
    return multiplyDecimals(order.quantity, notionalPrice);
}

function selectNotionalPrice(order, marketReferencePrice) {
    return order.price || optionalPositiveDecimalString(marketReferencePrice) || order.stopPrice || null;
}

function validateMinNotional(errors, notional, minNotional, filterType) {
    if (compareDecimals(notional, minNotional) < 0) {
        pushError(errors, "notional", `${filterType}_MIN`, `notional must be at least ${minNotional}`);
    }
}

function validateMaxNotional(errors, notional, maxNotional, filterType) {
    if (compareDecimals(notional, maxNotional) > 0) {
        pushError(errors, "notional", `${filterType}_MAX`, `notional must be at most ${maxNotional}`);
    }
}

function validateOptionalRiskContext({
    errors,
    order,
    filters,
    openOrderCount,
    openAlgoOrderCount,
    baseAssetPositionQuantity,
}) {
    const normalizedOpenOrderCount = Number(openOrderCount);
    if (filters.maxNumOrders && Number.isFinite(normalizedOpenOrderCount) && normalizedOpenOrderCount >= filters.maxNumOrders.maxNumOrders) {
        pushError(errors, "symbol", "MAX_NUM_ORDERS", `open order count must be below ${filters.maxNumOrders.maxNumOrders}`);
    }

    const normalizedOpenAlgoOrderCount = Number(openAlgoOrderCount);
    if (filters.maxNumAlgoOrders && Number.isFinite(normalizedOpenAlgoOrderCount) && normalizedOpenAlgoOrderCount >= filters.maxNumAlgoOrders.maxNumAlgoOrders) {
        pushError(errors, "symbol", "MAX_NUM_ALGO_ORDERS", `open algo order count must be below ${filters.maxNumAlgoOrders.maxNumAlgoOrders}`);
    }

    const positionQuantity = optionalPositiveOrZeroDecimalString(baseAssetPositionQuantity);
    if (filters.maxPosition && order.side === "BUY" && positionQuantity && order.quantity) {
        const projected = addDecimals(positionQuantity, order.quantity);
        if (compareDecimals(projected, filters.maxPosition.maxPosition) > 0) {
            pushError(errors, "quantity", "MAX_POSITION", `projected position must be at most ${filters.maxPosition.maxPosition}`);
        }
    }
}

function pushError(errors, field, code, message) {
    errors.push({ field, code, message });
}

function enabledDecimal(value) {
    const decimal = optionalPositiveOrZeroDecimalString(value);
    if (!decimal || isZeroDecimal(decimal)) return null;
    return decimal;
}

function positiveDecimalString(value) {
    const decimal = optionalPositiveOrZeroDecimalString(value);
    if (!decimal || isZeroDecimal(decimal)) return null;
    return decimal;
}

function optionalPositiveDecimalString(value) {
    if (value === undefined || value === null || value === "") return null;
    return positiveDecimalString(value);
}

function optionalPositiveOrZeroDecimalString(value) {
    const normalized = optionalString(value);
    if (!normalized || !/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    return normalizeDecimalString(normalized);
}

function normalizeDecimalString(value) {
    const [rawInt, rawFrac = ""] = String(value).split(".");
    const intPart = rawInt.replace(/^0+(?=\d)/, "") || "0";
    const fracPart = rawFrac.replace(/0+$/, "");
    return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function compareDecimals(left, right) {
    const { leftInt, rightInt } = alignDecimals(left, right);
    if (leftInt < rightInt) return -1;
    if (leftInt > rightInt) return 1;
    return 0;
}

function addDecimals(left, right) {
    const { leftInt, rightInt, scale } = alignDecimals(left, right);
    return formatScaledDecimal(leftInt + rightInt, scale);
}

function multiplyDecimals(left, right) {
    const leftParts = parseDecimal(left);
    const rightParts = parseDecimal(right);
    return formatScaledDecimal(leftParts.value * rightParts.value, leftParts.scale + rightParts.scale);
}

function isDecimalMultiple(value, step) {
    const { leftInt, rightInt } = alignDecimals(value, step);
    return rightInt !== 0n && leftInt % rightInt === 0n;
}

function isZeroDecimal(value) {
    return parseDecimal(value).value === 0n;
}

function alignDecimals(left, right) {
    const leftParts = parseDecimal(left);
    const rightParts = parseDecimal(right);
    const scale = Math.max(leftParts.scale, rightParts.scale);
    return {
        leftInt: leftParts.value * 10n ** BigInt(scale - leftParts.scale),
        rightInt: rightParts.value * 10n ** BigInt(scale - rightParts.scale),
        scale,
    };
}

function parseDecimal(value) {
    const normalized = optionalPositiveOrZeroDecimalString(value);
    if (normalized === null) {
        throw new Error(`Invalid decimal: ${value}`);
    }
    const [intPart, fracPart = ""] = normalized.split(".");
    return {
        value: BigInt(`${intPart}${fracPart}` || "0"),
        scale: fracPart.length,
    };
}

function formatScaledDecimal(value, scale) {
    const sign = value < 0n ? "-" : "";
    const digits = String(value < 0n ? -value : value).padStart(scale + 1, "0");
    if (scale === 0) return `${sign}${digits}`;
    const intPart = digits.slice(0, -scale) || "0";
    const fracPart = digits.slice(-scale).replace(/0+$/, "");
    return fracPart ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

function optionalString(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}
