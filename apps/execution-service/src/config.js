import "dotenv/config";

const SERVICE = "execution";
const DEFAULT_BINANCE_API_BASE = "https://testnet.binance.vision";
const DEFAULT_BINANCE_WS_BASE = "wss://stream.testnet.binance.vision";

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

function requireExactLength(name, length, errors) {
    const value = requireString(name, errors);
    if (value && value.length !== length) {
        errors.push(`${name} must be exactly ${length} characters`);
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

function validateBinanceRestUrl(name, value, errors) {
    const parsed = validateUrl(name, value, ["https:"], errors);
    if (!parsed) return "";
    if (parsed.hostname.toLowerCase() !== "testnet.binance.vision") {
        errors.push(`${name} must point to Binance Spot Testnet`);
    }
    return parsed.origin;
}

function validateBinanceWsUrl(name, value, errors) {
    const parsed = validateUrl(name, value, ["wss:"], errors);
    if (!parsed) return "";
    if (parsed.hostname.toLowerCase() !== "stream.testnet.binance.vision") {
        errors.push(`${name} must point to Binance Spot Testnet streams`);
    }
    return parsed.origin;
}

function parseSymbols(value, errors) {
    const symbols = String(value || "btcusdt")
        .split(",")
        .map((symbol) => symbol.trim().toLowerCase())
        .filter(Boolean);

    if (symbols.length === 0) {
        errors.push("SYMBOLS must include at least one symbol when MARKET_MODE is not all");
    }

    for (const symbol of symbols) {
        if (!/^[a-z0-9]{2,30}$/.test(symbol)) {
            errors.push("SYMBOLS must be comma-separated Binance symbols such as btcusdt,ethusdt");
            break;
        }
    }

    return symbols;
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
        process.env.DATABASE_URL,
        process.env.REDIS_URL,
        process.env.ENCRYPTION_KEY,
    ].filter(Boolean);

    let message = String(error?.message || error || "Unknown error");
    for (const secret of secrets) {
        message = message.split(String(secret)).join("<redacted>");
    }

    return message
        .replace(/(postgres(?:ql)?:\/\/)([^@\s/]+)@/gi, "$1<redacted>@")
        .replace(/(redis(?:s)?:\/\/)([^@\s/]+)@/gi, "$1<redacted>@");
}

const errors = [];

const databaseUrl = requireString("DATABASE_URL", errors);
if (databaseUrl) validateUrl("DATABASE_URL", databaseUrl, ["postgresql:", "postgres:"], errors);

const redisUrl = requireString("REDIS_URL", errors);
if (redisUrl) validateUrl("REDIS_URL", redisUrl, ["redis:", "rediss:"], errors);

const encryptionKey = requireExactLength("ENCRYPTION_KEY", 32, errors);
const binanceApiBase = validateBinanceRestUrl(
    "BINANCE_API_BASE",
    readEnv("BINANCE_API_BASE", DEFAULT_BINANCE_API_BASE),
    errors
);
const binanceWsBase = validateBinanceWsUrl(
    "BINANCE_WS_BASE",
    readEnv("BINANCE_WS_BASE", DEFAULT_BINANCE_WS_BASE),
    errors
);
const accountCacheMs = parseInteger("ACCOUNT_CACHE_MS", 5000, errors, { min: 0 });
const symbolCacheMs = parseInteger("SYMBOL_CACHE_MS", 600000, errors, { min: 0 });
const marketMode = readEnv("MARKET_MODE", "all").toLowerCase();
const symbols = parseSymbols(readEnv("SYMBOLS", "btcusdt"), errors);

if (marketMode !== "all" && marketMode !== "symbols") {
    errors.push("MARKET_MODE must be either all or symbols");
}

if (errors.length > 0) {
    console.error(`[${SERVICE}] Configuration error:`);
    for (const error of errors) {
        console.error(`[${SERVICE}] - ${error}`);
    }
    process.exit(1);
}

export const config = Object.freeze({
    databaseUrl,
    redisUrl,
    encryptionKey,
    commandsChannel: readEnv("COMMANDS_CHANNEL", "commands:order:submit"),
    eventsChannel: readEnv("EVENTS_CHANNEL", "events:order:status"),
    pricesChannel: readEnv("PRICES_CHANNEL", "events:price:update"),
    balancesChannel: readEnv("BALANCES_CHANNEL", "events:account:balances"),
    chartReqChannel: readEnv("CHART_REQ_CHANNEL", "events:chart:request"),
    chartsChannel: readEnv("CHARTS_CHANNEL", "events:chart:update"),
    defaultKlineInterval: readEnv("DEFAULT_KLINE_INTERVAL", "1m"),
    accountReqChannel: readEnv("ACCOUNT_REQ_CHANNEL", "events:account:request"),
    accountResChannel: readEnv("ACCOUNT_RES_CHANNEL", "events:account:response"),
    accountCacheMs,
    symbolReqChannel: readEnv("SYMBOL_REQ_CHANNEL", "events:symbol:request"),
    symbolResChannel: readEnv("SYMBOL_RES_CHANNEL", "events:symbol:response"),
    symbolCacheMs,
    binanceApiBase,
    binanceWsBase,
    marketMode,
    symbols,
});

export function logStartupConfig() {
    console.log(`[${SERVICE}] configuration OK`, {
        databaseUrl: redactUrl(config.databaseUrl),
        redisUrl: redactUrl(config.redisUrl),
        commandsChannel: config.commandsChannel,
        eventsChannel: config.eventsChannel,
        pricesChannel: config.pricesChannel,
        balancesChannel: config.balancesChannel,
        binanceApiBase: redactUrl(config.binanceApiBase),
        binanceWsBase: redactUrl(config.binanceWsBase),
        marketMode: config.marketMode,
        symbols: config.symbols,
        accountCacheMs: config.accountCacheMs,
        symbolCacheMs: config.symbolCacheMs,
    });
}
