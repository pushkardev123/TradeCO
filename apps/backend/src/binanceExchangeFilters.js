import {
    validateOrderAgainstExchangeFilters,
} from "@tradeco/redis-stream-contracts";
import { config } from "./config.js";

const DEFAULT_SYMBOL_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_AVG_PRICE_CACHE_MS = 10 * 1000;

const defaultValidator = createBinanceFilterValidator();

export async function validateOrderDraftAgainstBinanceFilters(orderDraft) {
    return defaultValidator.validateOrderDraft(orderDraft);
}

export function createBinanceFilterValidator({
    baseUrl = config.binanceApiBase,
    fetchImpl = globalThis.fetch,
    symbolCacheMs = DEFAULT_SYMBOL_CACHE_MS,
    averagePriceCacheMs = DEFAULT_AVG_PRICE_CACHE_MS,
    now = () => Date.now(),
} = {}) {
    const symbolCache = new Map();
    const averagePriceCache = new Map();

    async function validateOrderDraft(orderDraft) {
        const symbol = normalizeSymbol(orderDraft?.symbol);
        const symbolInfo = await getSymbolInfo(symbol);
        const averagePrice = shouldFetchAveragePrice(orderDraft)
            ? await getAveragePrice(symbol)
            : null;

        return validateOrderAgainstExchangeFilters(orderDraft, symbolInfo, {
            averagePrice: averagePrice?.price,
        });
    }

    async function getSymbolInfo(symbol) {
        const cached = getCache(symbolCache, symbol, now);
        if (cached) return cached;

        const url = new URL("/api/v3/exchangeInfo", normalizeBaseUrl(baseUrl));
        url.searchParams.set("symbol", symbol);
        const data = await fetchJson(url, { fetchImpl, resourceName: "exchangeInfo" });
        const symbolInfo = data?.symbols?.[0];
        if (!symbolInfo) {
            throw serviceUnavailable(`Unable to load Binance filters for ${symbol}`);
        }

        setCache(symbolCache, symbol, symbolInfo, symbolCacheMs, now);
        return symbolInfo;
    }

    async function getAveragePrice(symbol) {
        const cached = getCache(averagePriceCache, symbol, now);
        if (cached) return cached;

        const url = new URL("/api/v3/avgPrice", normalizeBaseUrl(baseUrl));
        url.searchParams.set("symbol", symbol);
        const data = await fetchJson(url, { fetchImpl, resourceName: "avgPrice" });
        if (!data?.price) {
            throw serviceUnavailable(`Unable to load Binance average price for ${symbol}`);
        }

        const averagePrice = { symbol, price: data.price, mins: data.mins ?? null, closeTime: data.closeTime ?? null };
        setCache(averagePriceCache, symbol, averagePrice, averagePriceCacheMs, now);
        return averagePrice;
    }

    return {
        validateOrderDraft,
        getSymbolInfo,
        getAveragePrice,
    };
}

function shouldFetchAveragePrice(orderDraft) {
    const orderType = String(orderDraft?.orderType || orderDraft?.type || "MARKET").toUpperCase();
    return !orderDraft?.price || orderType === "MARKET" || orderType === "STOP_LOSS" || orderType === "TAKE_PROFIT";
}

async function fetchJson(url, { fetchImpl, resourceName }) {
    if (typeof fetchImpl !== "function") {
        throw serviceUnavailable("fetch is not available for Binance filter validation");
    }

    let response;
    try {
        response = await fetchImpl(url);
    } catch {
        throw serviceUnavailable(`Unable to load Binance ${resourceName}`);
    }

    let data;
    try {
        data = await response.json();
    } catch {
        throw serviceUnavailable(`Invalid Binance ${resourceName} response`);
    }

    if (!response.ok) {
        throw serviceUnavailable(data?.msg || data?.message || `Unable to load Binance ${resourceName}`);
    }

    return data;
}

function getCache(cache, key, now) {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= now()) {
        if (entry) cache.delete(key);
        return null;
    }
    return entry.value;
}

function setCache(cache, key, value, ttlMs, now) {
    cache.set(key, { value, expiresAt: now() + ttlMs });
}

function normalizeSymbol(value) {
    const symbol = String(value || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,30}$/.test(symbol)) {
        throw serviceUnavailable("symbol is required for Binance filter validation");
    }
    return symbol;
}

function normalizeBaseUrl(value) {
    return String(value || "").replace(/\/+$/, "");
}

function serviceUnavailable(message) {
    const error = new Error(message);
    error.statusCode = 503;
    return error;
}
