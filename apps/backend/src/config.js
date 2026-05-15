import "dotenv/config";
import { getOrderStreamConfig } from "@tradeco/redis-stream-contracts";

const SERVICE = "backend";
const DEFAULT_PORT = 8080;
const DEFAULT_COMMANDS_CHANNEL = "commands:order:submit";
const DEFAULT_CORS_ORIGIN = "http://localhost:3000";
const DEFAULT_BINANCE_API_BASE = "https://testnet.binance.vision";

function readEnv(name, fallback = undefined) {
    const value = process.env[name];
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }
    return String(value).trim();
}

function parsePort(name, fallback, errors) {
    const raw = readEnv(name, String(fallback));
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        errors.push(`${name} must be an integer between 1 and 65535`);
        return fallback;
    }
    return value;
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

function requireMinLength(name, length, errors) {
    const value = requireString(name, errors);
    if (value && value.length < length) {
        errors.push(`${name} must be at least ${length} characters`);
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

function validateBinanceTestnetUrl(name, value, errors) {
    const parsed = validateUrl(name, value, ["https:"], errors);
    if (!parsed) return "";
    if (parsed.hostname.toLowerCase() !== "testnet.binance.vision") {
        errors.push(`${name} must point to Binance Spot Testnet`);
    }
    return parsed.origin;
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
        process.env.DATABASE_URL,
        process.env.REDIS_URL,
        process.env.JWT_SECRET,
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

const jwtSecret = requireMinLength("JWT_SECRET", 32, errors);
const encryptionKey = requireExactLength("ENCRYPTION_KEY", 32, errors);
const binanceApiBase = validateBinanceTestnetUrl(
    "BINANCE_API_BASE",
    readEnv("BINANCE_API_BASE", DEFAULT_BINANCE_API_BASE),
    errors
);
const port = parsePort("PORT", DEFAULT_PORT, errors);
const corsOrigins = parseCorsOrigins(readEnv("CORS_ORIGIN", DEFAULT_CORS_ORIGIN), errors);
let orderStreamConfig = null;

try {
    orderStreamConfig = getOrderStreamConfig(process.env);
} catch (error) {
    errors.push(error?.message || "Redis stream configuration is invalid");
}

if (errors.length > 0) {
    console.error(`[${SERVICE}] Configuration error:`);
    for (const error of errors) {
        console.error(`[${SERVICE}] - ${error}`);
    }
    process.exit(1);
}

export const config = Object.freeze({
    port,
    databaseUrl,
    redisUrl,
    jwtSecret,
    encryptionKey,
    commandsChannel: readEnv("COMMANDS_CHANNEL", DEFAULT_COMMANDS_CHANNEL),
    orderCommandStream: orderStreamConfig.streams.commands,
    corsOrigins,
    binanceApiBase,
});

export function isCorsOriginAllowed(origin) {
    if (!origin) return true;
    if (config.corsOrigins.includes("*")) return true;
    return config.corsOrigins.includes(origin);
}

export function logStartupConfig() {
    console.log(`[${SERVICE}] configuration OK`, {
        port: config.port,
        databaseUrl: redactUrl(config.databaseUrl),
        redisUrl: redactUrl(config.redisUrl),
        commandsChannel: config.commandsChannel,
        orderCommandStream: config.orderCommandStream,
        corsOrigins: config.corsOrigins,
        binanceApiBase: redactUrl(config.binanceApiBase),
    });
}
