import "dotenv/config";

const SERVICE = "event-service";
const DEFAULT_PORT = 8081;
const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

function readEnv(name, fallback = undefined) {
    const value = process.env[name];
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }
    return String(value).trim();
}

function requireString(name, errors) {
    const value = readEnv(name);
    if (!value) {
        errors.push(`${name} is required`);
    }
    return value || "";
}

function requireMinLength(name, length, errors) {
    const value = requireString(name, errors);
    if (value && value.length < length) {
        errors.push(`${name} must be at least ${length} characters`);
    }
    return value;
}

function parseInteger(name, fallback, errors, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = readEnv(name, String(fallback));
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        errors.push(`${name} must be an integer between ${min} and ${max}`);
        return fallback;
    }
    return value;
}

function validateUrl(name, value, protocols, errors) {
    try {
        const parsed = new URL(value);
        if (!protocols.includes(parsed.protocol)) {
            errors.push(`${name} must use one of: ${protocols.join(", ")}`);
        }
        return parsed;
    } catch {
        errors.push(`${name} must be a valid URL`);
        return null;
    }
}

function parseCorsOrigins(value, errors) {
    const origins = String(value || DEFAULT_CORS_ORIGIN)
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    if (origins.length === 0) {
        errors.push("CORS_ORIGIN must include at least one origin");
        return [DEFAULT_CORS_ORIGIN];
    }

    for (const origin of origins) {
        if (origin === "*") continue;
        validateUrl("CORS_ORIGIN", origin, ["http:", "https:"], errors);
    }

    return origins;
}

export function redactUrl(value) {
    try {
        const parsed = new URL(value);
        const auth = parsed.username || parsed.password ? "<redacted>@" : "";
        const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
        return `${parsed.protocol}//${auth}${parsed.host}${path}`;
    } catch {
        return "<invalid-url>";
    }
}

export function safeErrorMessage(error) {
    const secrets = [
        process.env.REDIS_URL,
        process.env.JWT_SECRET,
    ].filter(Boolean);

    let message = String(error?.message || error || "Unknown error");
    for (const secret of secrets) {
        message = message.split(String(secret)).join("<redacted>");
    }

    return message.replace(/(redis(?:s)?:\/\/)([^@\s/]+)@/gi, "$1<redacted>@");
}

function logConfig(level, msg, fields = {}) {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service: SERVICE,
        msg,
        ...fields,
    });
    if (level === "error") console.error(line);
    else console.log(line);
}

const errors = [];

const redisUrl = requireString("REDIS_URL", errors);
if (redisUrl) validateUrl("REDIS_URL", redisUrl, ["redis:", "rediss:"], errors);

const jwtSecret = requireMinLength("JWT_SECRET", 32, errors);
const port = parseInteger("PORT", DEFAULT_PORT, errors, { min: 1, max: 65535 });
const accountCacheMs = parseInteger("ACCOUNT_CACHE_MS", 5000, errors, { min: 0 });
const symbolCacheMs = parseInteger("SYMBOL_CACHE_MS", 600000, errors, { min: 0 });
const corsOrigins = parseCorsOrigins(readEnv("CORS_ORIGIN", DEFAULT_CORS_ORIGIN), errors);
const binanceApiBase = readEnv("BINANCE_API_BASE", "https://testnet.binance.vision");
validateUrl("BINANCE_API_BASE", binanceApiBase, ["http:", "https:"], errors);

if (errors.length > 0) {
    logConfig("error", "configuration.error", { errors });
    process.exit(1);
}

export const config = Object.freeze({
    port,
    redisUrl,
    jwtSecret,
    eventsChannel: readEnv("EVENTS_CHANNEL", "events:order:status"),
    ordersChannel: readEnv("ORDERS_CHANNEL", "commands:order:submit"),
    pricesChannel: readEnv("PRICES_CHANNEL", "events:price:update"),
    balancesChannel: readEnv("BALANCES_CHANNEL", "events:account:balances"),
    chartReqChannel: readEnv("CHART_REQ_CHANNEL", "events:chart:request"),
    chartsChannel: readEnv("CHARTS_CHANNEL", "events:chart:update"),
    marketReqChannel: readEnv("MARKET_REQ_CHANNEL", "events:market:request"),
    marketDetailChannel: readEnv("MARKET_DETAIL_CHANNEL", "events:market:details"),
    accountReqChannel: readEnv("ACCOUNT_REQ_CHANNEL", "events:account:request"),
    accountResChannel: readEnv("ACCOUNT_RES_CHANNEL", "events:account:response"),
    accountCacheMs,
    symbolReqChannel: readEnv("SYMBOL_REQ_CHANNEL", "events:symbol:request"),
    symbolResChannel: readEnv("SYMBOL_RES_CHANNEL", "events:symbol:response"),
    symbolCacheMs,
    binanceApiBase,
    corsOrigins,
});

export function getCorsAllowOrigin(origin) {
    if (config.corsOrigins.includes("*")) return "*";
    if (!origin) return config.corsOrigins[0] || DEFAULT_CORS_ORIGIN;
    if (config.corsOrigins.includes(origin)) return origin;
    return null;
}

export function logStartupConfig() {
    logConfig("info", "configuration.ok", {
        port: config.port,
        redisUrl: redactUrl(config.redisUrl),
        corsOrigins: config.corsOrigins,
        eventsChannel: config.eventsChannel,
        pricesChannel: config.pricesChannel,
        balancesChannel: config.balancesChannel,
        chartsChannel: config.chartsChannel,
        marketReqChannel: config.marketReqChannel,
        marketDetailChannel: config.marketDetailChannel,
        binanceApiBase: redactUrl(config.binanceApiBase),
        accountCacheMs: config.accountCacheMs,
        symbolCacheMs: config.symbolCacheMs,
    });
}
