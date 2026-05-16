import "dotenv/config";
import {
    createOrderCommandConsumerName,
    getOrderStreamConfig,
} from "@tradeco/redis-stream-contracts";

const SERVICE = "execution-service";
const DEFAULT_BINANCE_API_BASE = "https://testnet.binance.vision";
const DEFAULT_BINANCE_WS_BASE = "wss://stream.testnet.binance.vision";
const DEFAULT_BINANCE_WS_API_BASE = "wss://ws-api.testnet.binance.vision/ws-api/v3";

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

function parseBoolean(name, fallback = false) {
    const raw = readEnv(name);
    if (raw === undefined) return fallback;
    return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
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

function validateBinanceWsApiUrl(name, value, errors) {
    const parsed = validateUrl(name, value, ["wss:"], errors);
    if (!parsed) return "";
    if (parsed.hostname.toLowerCase() !== "ws-api.testnet.binance.vision") {
        errors.push(`${name} must point to Binance Spot Testnet WebSocket API`);
    }
    const pathname = parsed.pathname.replace(/\/$/, "");
    if (pathname !== "/ws-api/v3") {
        errors.push(`${name} path must be /ws-api/v3`);
    }
    return `${parsed.protocol}//${parsed.host}${pathname}`;
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
const binanceWsApiBase = validateBinanceWsApiUrl(
    "BINANCE_WS_API_BASE",
    readEnv("BINANCE_WS_API_BASE", DEFAULT_BINANCE_WS_API_BASE),
    errors
);
const accountCacheMs = parseInteger("ACCOUNT_CACHE_MS", 5000, errors, { min: 0 });
const symbolCacheMs = parseInteger("SYMBOL_CACHE_MS", 600000, errors, { min: 0 });
const healthPort = parseInteger("HEALTH_PORT", 8082, errors, { min: 1, max: 65535 });
const reconciliationIntervalMs = parseInteger("RECONCILIATION_INTERVAL_MS", 60000, errors, { min: 0 });
const reconciliationStaleMs = parseInteger("RECONCILIATION_STALE_MS", 30000, errors, { min: 0 });
const reconciliationBatchSize = parseInteger("RECONCILIATION_BATCH_SIZE", 100, errors, { min: 1, max: 500 });
const marketMode = readEnv("MARKET_MODE", "all").toLowerCase();
const symbols = parseSymbols(readEnv("SYMBOLS", "btcusdt"), errors);
let orderStreamConfig = null;

try {
    orderStreamConfig = getOrderStreamConfig(process.env);
} catch (error) {
    errors.push(error?.message || "Redis stream configuration is invalid");
}

if (marketMode !== "all" && marketMode !== "symbols") {
    errors.push("MARKET_MODE must be either all or symbols");
}

if (errors.length > 0) {
    logConfig("error", "configuration.error", { errors });
    process.exit(1);
}

export const config = Object.freeze({
    databaseUrl,
    redisUrl,
    encryptionKey,
    commandsChannel: readEnv("COMMANDS_CHANNEL", "commands:order:submit"),
    legacyCommandsChannelEnabled: parseBoolean("LEGACY_COMMANDS_CHANNEL_ENABLED", false),
    eventsChannel: readEnv("EVENTS_CHANNEL", "events:order:status"),
    orderCommandStream: orderStreamConfig.streams.commands,
    orderCommandDlqStream: orderStreamConfig.streams.commandDlq,
    orderCommandConsumerGroup: orderStreamConfig.consumerGroups.execution,
    orderCommandConsumerName: readEnv("ORDER_COMMAND_CONSUMER_NAME", createOrderCommandConsumerName()),
    orderCommandReadCount: orderStreamConfig.readCount,
    orderCommandClaimIdleMs: orderStreamConfig.claimIdleMs,
    orderCommandMaxAttempts: orderStreamConfig.maxAttempts,
    pricesChannel: readEnv("PRICES_CHANNEL", "events:price:update"),
    balancesChannel: readEnv("BALANCES_CHANNEL", "events:account:balances"),
    chartReqChannel: readEnv("CHART_REQ_CHANNEL", "events:chart:request"),
    chartsChannel: readEnv("CHARTS_CHANNEL", "events:chart:update"),
    marketReqChannel: readEnv("MARKET_REQ_CHANNEL", "events:market:request"),
    marketDetailChannel: readEnv("MARKET_DETAIL_CHANNEL", "events:market:details"),
    defaultKlineInterval: readEnv("DEFAULT_KLINE_INTERVAL", "1m"),
    accountReqChannel: readEnv("ACCOUNT_REQ_CHANNEL", "events:account:request"),
    accountResChannel: readEnv("ACCOUNT_RES_CHANNEL", "events:account:response"),
    accountCacheMs,
    reconciliationEnabled: parseBoolean("RECONCILIATION_ENABLED", true),
    reconciliationIntervalMs,
    reconciliationStaleMs,
    reconciliationBatchSize,
    symbolReqChannel: readEnv("SYMBOL_REQ_CHANNEL", "events:symbol:request"),
    symbolResChannel: readEnv("SYMBOL_RES_CHANNEL", "events:symbol:response"),
    symbolCacheMs,
    healthPort,
    binanceApiBase,
    binanceWsBase,
    binanceWsApiBase,
    marketMode,
    symbols,
});

export function logStartupConfig() {
    logConfig("info", "configuration.ok", {
        databaseUrl: redactUrl(config.databaseUrl),
        redisUrl: redactUrl(config.redisUrl),
        commandsChannel: config.commandsChannel,
        legacyCommandsChannelEnabled: config.legacyCommandsChannelEnabled,
        eventsChannel: config.eventsChannel,
        orderCommandStream: config.orderCommandStream,
        orderCommandDlqStream: config.orderCommandDlqStream,
        orderCommandConsumerGroup: config.orderCommandConsumerGroup,
        orderCommandConsumerName: config.orderCommandConsumerName,
        orderCommandReadCount: config.orderCommandReadCount,
        orderCommandClaimIdleMs: config.orderCommandClaimIdleMs,
        orderCommandMaxAttempts: config.orderCommandMaxAttempts,
        pricesChannel: config.pricesChannel,
        balancesChannel: config.balancesChannel,
        marketReqChannel: config.marketReqChannel,
        marketDetailChannel: config.marketDetailChannel,
        binanceApiBase: redactUrl(config.binanceApiBase),
        binanceWsBase: redactUrl(config.binanceWsBase),
        binanceWsApiBase: redactUrl(config.binanceWsApiBase),
        marketMode: config.marketMode,
        symbols: config.symbols,
        accountCacheMs: config.accountCacheMs,
        reconciliationEnabled: config.reconciliationEnabled,
        reconciliationIntervalMs: config.reconciliationIntervalMs,
        reconciliationStaleMs: config.reconciliationStaleMs,
        reconciliationBatchSize: config.reconciliationBatchSize,
        symbolCacheMs: config.symbolCacheMs,
        healthPort: config.healthPort,
    });
}
