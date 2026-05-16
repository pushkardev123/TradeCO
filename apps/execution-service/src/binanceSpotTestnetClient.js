import crypto from "crypto";
import https from "https";
import querystring from "querystring";
import { isPositiveDecimal } from "./tradingDecimal.js";

export const BINANCE_SPOT_TESTNET_REST_BASE = "https://testnet.binance.vision";
export const BINANCE_RESPONSE_METADATA = Symbol.for("tradeco.binance.responseMetadata");

const SIGNED_METHODS = new Set(["GET", "POST", "DELETE"]);
const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const REDACTED_FIELD_NAMES = new Set([
    "apikey",
    "api_key",
    "authorization",
    "secretkey",
    "secret_key",
    "signature",
    "x-mbx-apikey",
]);

export class BinanceApiError extends Error {
    constructor({ statusCode, code, message, body, metadata, redactions = [] }) {
        super(redactSensitiveText(message || `HTTP ${statusCode || "error"}`, redactions));
        this.name = "BinanceApiError";
        this.statusCode = statusCode || null;
        this.code = code ?? null;
        this.body = sanitizeErrorBody(body, redactions);
        this.metadata = metadata || { rateLimits: {} };
    }
}

export class BinanceSpotTestnetClient {
    constructor({
        baseUrl = BINANCE_SPOT_TESTNET_REST_BASE,
        recvWindow = 5000,
        timestamp = () => Date.now(),
        transport = createHttpsTransport(),
    } = {}) {
        this.baseUrl = normalizeBinanceSpotTestnetRestBase(baseUrl);
        this.recvWindow = normalizeRecvWindow(recvWindow);
        this.timestamp = timestamp;
        this.transport = transport;
    }

    async request({ method = "GET", path, apiKey, params, bodyParams, headers = {}, redactions = [] } = {}) {
        const normalizedMethod = normalizeMethod(method, REQUEST_METHODS);
        const url = buildRequestUrl({ baseUrl: this.baseUrl, path, params });
        const body = bodyParams ? encodeParams(bodyParams) : undefined;
        const requestHeaders = { ...headers };

        if (apiKey) {
            requestHeaders["X-MBX-APIKEY"] = apiKey;
        }

        if (body !== undefined) {
            requestHeaders["Content-Type"] = "application/x-www-form-urlencoded";
            requestHeaders["Content-Length"] = Buffer.byteLength(body);
        }

        const response = await this.transport({
            method: normalizedMethod,
            url,
            headers: requestHeaders,
            body,
        });

        return normalizeHttpResponse(response, { redactions: [apiKey, ...redactions] });
    }

    async signedRequest({ method, path, apiKey, secretKey, params } = {}) {
        const normalizedMethod = normalizeMethod(method, SIGNED_METHODS);
        const normalizedApiKey = requiredString(apiKey, "apiKey");
        const normalizedSecretKey = requiredString(secretKey, "secretKey");
        const signedParams = signParams({
            params,
            secretKey: normalizedSecretKey,
            timestamp: this.timestamp(),
            recvWindow: this.recvWindow,
        });

        return this.request({
            method: normalizedMethod,
            path,
            apiKey: normalizedApiKey,
            params: signedParams,
            redactions: [normalizedSecretKey],
        });
    }

    signedGet(options = {}) {
        return this.signedRequest({ ...options, method: "GET" });
    }

    signedPost(options = {}) {
        return this.signedRequest({ ...options, method: "POST" });
    }

    signedDelete(options = {}) {
        return this.signedRequest({ ...options, method: "DELETE" });
    }

    async fetchKlineSnapshot({ symbol, interval, limit = 50 } = {}) {
        const sym = normalizeSymbol(symbol);
        const iv = normalizeInterval(interval);
        const lim = Math.max(1, Math.min(Number(limit) || 500, 1000));
        const { data, metadata } = await this.request({
            method: "GET",
            path: "/api/v3/klines",
            params: { symbol: sym, interval: iv, limit: lim },
        });

        if (!Array.isArray(data)) {
            throw new Error("klines response is not an array");
        }

        const candles = data.map((k) => {
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
                open,
                high,
                low,
                close,
                volume: Number.isFinite(volume) ? volume : 0,
                startTime,
                closeTime,
            };
        }).filter(Boolean);

        return attachMetadata({ symbol: sym, interval: iv, candles }, metadata);
    }

    async fetchSymbolInfo({ symbol } = {}) {
        const sym = normalizeSymbol(symbol);
        const { data, metadata } = await this.request({
            method: "GET",
            path: "/api/v3/exchangeInfo",
            params: { symbol: sym },
        });

        const s = data?.symbols?.[0];
        if (!s) {
            throw new Error("symbol not found");
        }

        const filters = Array.isArray(s.filters) ? s.filters : [];
        const lot = filters.find((f) => f.filterType === "LOT_SIZE");
        const priceFilter = filters.find((f) => f.filterType === "PRICE_FILTER");
        const notional = filters.find((f) => f.filterType === "MIN_NOTIONAL") || filters.find((f) => f.filterType === "NOTIONAL");

        return attachMetadata({
            symbol: sym,
            baseAsset: s.baseAsset,
            quoteAsset: s.quoteAsset,
            minQty: lot?.minQty,
            maxQty: lot?.maxQty,
            stepSize: lot?.stepSize,
            tickSize: priceFilter?.tickSize,
            minPrice: priceFilter?.minPrice,
            maxPrice: priceFilter?.maxPrice,
            minNotional: notional?.minNotional,
            maxNotional: notional?.maxNotional,
            applyMinToMarket: notional?.applyMinToMarket ?? false,
            applyMaxToMarket: notional?.applyMaxToMarket ?? false,
            avgPriceMins: notional?.avgPriceMins ?? null,
            filters,
        }, metadata);
    }

    async fetchAveragePrice({ symbol } = {}) {
        const sym = normalizeSymbol(symbol);
        const { data, metadata } = await this.request({
            method: "GET",
            path: "/api/v3/avgPrice",
            params: { symbol: sym },
        });

        return attachMetadata({
            symbol: sym,
            mins: data?.mins ?? null,
            price: data?.price,
            closeTime: data?.closeTime ?? null,
        }, metadata);
    }

    async getAccount({ apiKey, secretKey } = {}) {
        const { data } = await this.signedGet({
            path: "/api/v3/account",
            apiKey,
            secretKey,
        });

        return data;
    }

    async getOrder(options = {}) {
        const params = buildGetOrderRequestParams(options);
        const { data } = await this.signedGet({
            path: "/api/v3/order",
            apiKey: options.apiKey,
            secretKey: options.secretKey,
            params,
        });

        return data;
    }

    async getOpenOrders(options = {}) {
        const params = buildOpenOrdersRequestParams(options);
        const { data } = await this.signedGet({
            path: "/api/v3/openOrders",
            apiKey: options.apiKey,
            secretKey: options.secretKey,
            params,
        });

        return data;
    }

    async getAllOrders(options = {}) {
        const params = buildAllOrdersRequestParams(options);
        const { data } = await this.signedGet({
            path: "/api/v3/allOrders",
            apiKey: options.apiKey,
            secretKey: options.secretKey,
            params,
        });

        return data;
    }

    async getMyTrades(options = {}) {
        const params = buildMyTradesRequestParams(options);
        const { data } = await this.signedGet({
            path: "/api/v3/myTrades",
            apiKey: options.apiKey,
            secretKey: options.secretKey,
            params,
        });

        return data;
    }

    async placeOrder(options = {}) {
        const params = buildOrderRequestParams(options);
        const { data } = await this.signedPost({
            path: "/api/v3/order",
            apiKey: options.apiKey,
            secretKey: options.secretKey,
            params,
        });

        return data;
    }

    async cancelOrder(options = {}) {
        const params = buildCancelOrderRequestParams(options);
        const { data } = await this.signedDelete({
            path: "/api/v3/order",
            apiKey: options.apiKey,
            secretKey: options.secretKey,
            params,
        });

        return data;
    }

    async cancelAllOpenOrders(options = {}) {
        const params = buildCancelAllOrdersRequestParams(options);
        const { data } = await this.signedDelete({
            path: "/api/v3/openOrders",
            apiKey: options.apiKey,
            secretKey: options.secretKey,
            params,
        });

        return data;
    }
}

export function createBinanceSpotTestnetClient(options = {}) {
    return new BinanceSpotTestnetClient(options);
}

export function normalizeBinanceSpotTestnetRestBase(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("BINANCE_API_BASE must be a valid Binance Spot Testnet URL");
    }

    if (parsed.protocol !== "https:") {
        throw new Error("BINANCE_API_BASE must use https for Binance Spot Testnet");
    }

    if (parsed.hostname.toLowerCase() !== "testnet.binance.vision") {
        throw new Error("BINANCE_API_BASE must point to Binance Spot Testnet");
    }

    return parsed.origin;
}

export function signParams({ params, secretKey, timestamp, recvWindow }) {
    const unsigned = sanitizeParams(params);
    delete unsigned.timestamp;
    delete unsigned.recvWindow;
    delete unsigned.signature;

    const signingParams = {
        ...unsigned,
        timestamp,
        recvWindow,
    };
    const query = encodeParams(signingParams);
    const signature = crypto.createHmac("sha256", secretKey).update(query).digest("hex");

    return {
        ...signingParams,
        signature,
    };
}

export function buildOrderRequestParams({
    symbol,
    side,
    orderType,
    quantity,
    quoteOrderQty,
    timeInForce,
    price,
    stopPrice,
    clientOrderId,
} = {}) {
    const type = String(orderType || "MARKET").toUpperCase();
    const mappedType = type === "STOP_MARKET" ? "STOP_LOSS" : type;

    const hasQuantity = quantity !== undefined && quantity !== null && quantity !== "";
    const hasQuoteOrderQty = quoteOrderQty !== undefined && quoteOrderQty !== null && quoteOrderQty !== "";

    if (hasQuantity && !isPositiveDecimal(quantity)) {
        throw new Error("quantity must be a positive decimal");
    }
    if (hasQuoteOrderQty && !isPositiveDecimal(quoteOrderQty)) {
        throw new Error("quoteOrderQty must be a positive decimal");
    }

    if (mappedType === "MARKET") {
        if (!hasQuantity && !hasQuoteOrderQty) {
            throw new Error("MARKET requires quantity or quoteOrderQty");
        }
        if (hasQuantity && hasQuoteOrderQty) {
            throw new Error("quantity and quoteOrderQty are mutually exclusive");
        }
    } else {
        if (!hasQuantity) {
            throw new Error(`${mappedType} requires quantity`);
        }
        if (hasQuoteOrderQty) {
            throw new Error("quoteOrderQty is only supported for MARKET orders");
        }
    }

    const params = {
        symbol: normalizeSymbol(symbol),
        side: requiredString(side, "side").toUpperCase(),
        type: mappedType,
    };

    if (hasQuantity) {
        params.quantity = quantity;
    } else {
        params.quoteOrderQty = quoteOrderQty;
    }

    if (clientOrderId) {
        params.newClientOrderId = String(clientOrderId);
    }

    if (mappedType === "LIMIT") {
        if (!isPositiveDecimal(price)) {
            throw new Error("LIMIT requires a valid price");
        }
        params.price = price;
        params.timeInForce = String(timeInForce || "GTC").toUpperCase();
    }

    if (mappedType === "LIMIT_MAKER") {
        if (!isPositiveDecimal(price)) {
            throw new Error("LIMIT_MAKER requires a valid price");
        }
        params.price = price;
    }

    if (mappedType === "STOP_LOSS" || mappedType === "TAKE_PROFIT") {
        if (!isPositiveDecimal(stopPrice)) {
            throw new Error(`${mappedType} requires a valid stopPrice`);
        }
        params.stopPrice = stopPrice;
    }

    if (mappedType === "STOP_LOSS_LIMIT" || mappedType === "TAKE_PROFIT_LIMIT") {
        if (!isPositiveDecimal(price)) {
            throw new Error(`${mappedType} requires a valid price`);
        }
        if (!isPositiveDecimal(stopPrice)) {
            throw new Error(`${mappedType} requires a valid stopPrice`);
        }
        params.price = price;
        params.stopPrice = stopPrice;
        params.timeInForce = String(timeInForce || "GTC").toUpperCase();
    }

    return params;
}

export function buildCancelOrderRequestParams({ symbol, orderId, binanceOrderId } = {}) {
    const params = {
        symbol: normalizeSymbol(symbol),
    };

    if (binanceOrderId !== undefined && binanceOrderId !== null && binanceOrderId !== "") {
        params.orderId = binanceOrderId;
    } else {
        params.origClientOrderId = String(orderId || "");
    }

    if (!params.orderId && !params.origClientOrderId) {
        throw new Error("orderId is required");
    }

    return params;
}

export function buildCancelAllOrdersRequestParams({ symbol } = {}) {
    return {
        symbol: normalizeSymbol(symbol),
    };
}

export function buildGetOrderRequestParams({ symbol, orderId, binanceOrderId } = {}) {
    const params = {
        symbol: normalizeSymbol(symbol),
    };

    if (binanceOrderId !== undefined && binanceOrderId !== null && binanceOrderId !== "") {
        params.orderId = binanceOrderId;
    } else {
        params.origClientOrderId = String(orderId || "");
    }

    if (!params.orderId && !params.origClientOrderId) {
        throw new Error("orderId is required");
    }

    return params;
}

export function buildOpenOrdersRequestParams({ symbol } = {}) {
    const params = {};
    if (symbol !== undefined && symbol !== null && String(symbol).trim() !== "") {
        params.symbol = normalizeSymbol(symbol);
    }
    return params;
}

export function buildAllOrdersRequestParams({ symbol, orderId, startTime, endTime, limit = 500 } = {}) {
    const params = {
        symbol: normalizeSymbol(symbol),
        limit: normalizeLimit(limit),
    };

    if (orderId !== undefined && orderId !== null && orderId !== "") params.orderId = orderId;
    if (startTime !== undefined && startTime !== null && startTime !== "") params.startTime = startTime;
    if (endTime !== undefined && endTime !== null && endTime !== "") params.endTime = endTime;

    return params;
}

export function buildMyTradesRequestParams({ symbol, orderId, startTime, endTime, fromId, limit = 500 } = {}) {
    const params = {
        symbol: normalizeSymbol(symbol),
        limit: normalizeLimit(limit),
    };

    if (orderId !== undefined && orderId !== null && orderId !== "") params.orderId = orderId;
    if (startTime !== undefined && startTime !== null && startTime !== "") params.startTime = startTime;
    if (endTime !== undefined && endTime !== null && endTime !== "") params.endTime = endTime;
    if (fromId !== undefined && fromId !== null && fromId !== "") params.fromId = fromId;

    return params;
}

export function getBinanceResponseMetadata(response) {
    return response?.[BINANCE_RESPONSE_METADATA] || null;
}

function createHttpsTransport() {
    return ({ method, url, headers, body }) => new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers }, (res) => {
            let responseBody = "";
            res.on("data", (chunk) => {
                responseBody += chunk;
            });
            res.on("end", () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: responseBody,
                });
            });
        });

        req.on("error", reject);
        if (body !== undefined) {
            req.write(body);
        }
        req.end();
    });
}

function normalizeHttpResponse(response = {}, { redactions = [] } = {}) {
    const statusCode = Number(response.statusCode || response.status || 0);
    const headers = response.headers || {};
    const rawBody = response.body === undefined || response.body === null ? "" : String(response.body);
    const metadata = {
        statusCode: statusCode || null,
        rateLimits: extractBinanceRateLimitHeaders(headers),
    };

    let data;
    try {
        data = rawBody ? JSON.parse(rawBody) : {};
    } catch {
        data = { raw: rawBody ? "<non-json response>" : "" };
    }

    if (statusCode >= 400 || isBinanceErrorPayload(data)) {
        throw new BinanceApiError({
            statusCode,
            code: data?.code,
            message: data?.msg || data?.message || `HTTP ${statusCode}`,
            body: data,
            metadata,
            redactions,
        });
    }

    return {
        data: attachMetadata(data, metadata),
        metadata,
    };
}

function extractBinanceRateLimitHeaders(headers = {}) {
    const out = {};

    for (const [key, value] of Object.entries(headers)) {
        const normalizedKey = String(key).toLowerCase();
        if (!normalizedKey.startsWith("x-mbx-used-weight") && !normalizedKey.startsWith("x-mbx-order-count")) {
            continue;
        }

        if (Array.isArray(value)) {
            out[normalizedKey] = value.join(",");
        } else if (value !== undefined && value !== null) {
            out[normalizedKey] = String(value);
        }
    }

    return out;
}

function attachMetadata(data, metadata) {
    if (data && (typeof data === "object" || typeof data === "function") && Object.isExtensible(data)) {
        Object.defineProperty(data, BINANCE_RESPONSE_METADATA, {
            value: Object.freeze({
                statusCode: metadata?.statusCode ?? null,
                rateLimits: Object.freeze({ ...(metadata?.rateLimits || {}) }),
            }),
            enumerable: false,
            configurable: true,
        });
    }

    return data;
}

function isBinanceErrorPayload(data) {
    return data && !Array.isArray(data) && Number(data.code) < 0;
}

function buildRequestUrl({ baseUrl, path, params }) {
    if (!path || typeof path !== "string" || !path.startsWith("/") || /^https?:\/\//i.test(path)) {
        throw new Error("Binance request path must be a relative API path");
    }

    const query = encodeParams(params);
    if (!query) {
        return `${baseUrl}${path}`;
    }

    return `${baseUrl}${path}${path.includes("?") ? "&" : "?"}${query}`;
}

function encodeParams(params) {
    return querystring.stringify(sanitizeParams(params));
}

function sanitizeParams(params = {}) {
    return Object.fromEntries(
        Object.entries(params)
            .filter(([, value]) => value !== undefined && value !== null && value !== "")
            .map(([key, value]) => [key, value]),
    );
}

function sanitizeErrorBody(value, redactions) {
    if (value === undefined || value === null) return value;

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeErrorBody(item, redactions));
    }

    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
            if (REDACTED_FIELD_NAMES.has(normalizeFieldName(key))) {
                return [key, "<redacted>"];
            }
            return [key, sanitizeErrorBody(child, redactions)];
        }));
    }

    if (typeof value === "string") {
        return redactSensitiveText(value, redactions);
    }

    return value;
}

function redactSensitiveText(value, redactions = []) {
    let out = String(value || "");
    for (const secret of redactions.filter((item) => item !== undefined && item !== null && String(item).length > 0)) {
        out = out.split(String(secret)).join("<redacted>");
    }

    return out
        .replace(/([?&]signature=)[^&\s]+/gi, "$1<redacted>")
        .replace(/(["']?signature["']?\s*[:=]\s*["']?)[a-f0-9]{16,}/gi, "$1<redacted>");
}

function normalizeFieldName(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function normalizeMethod(method, allowed) {
    const normalized = String(method || "").toUpperCase();
    if (!allowed.has(normalized)) {
        throw new Error(`Unsupported Binance request method: ${normalized || "<empty>"}`);
    }
    return normalized;
}

function normalizeRecvWindow(value) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized <= 0) {
        throw new Error("recvWindow must be a positive integer");
    }
    return normalized;
}

function normalizeLimit(value) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized)) return 500;
    return Math.max(1, Math.min(normalized, 1000));
}

function normalizeSymbol(value) {
    return requiredString(value, "symbol").toUpperCase();
}

function normalizeInterval(value) {
    return String(value || "1m").trim().toLowerCase();
}

function requiredString(value, fieldName) {
    const normalized = value === undefined || value === null ? "" : String(value).trim();
    if (!normalized) {
        throw new Error(`${fieldName} is required`);
    }
    return normalized;
}
