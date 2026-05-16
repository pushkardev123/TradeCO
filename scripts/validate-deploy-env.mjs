import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env.deploy");
const MAX_POSTGRES_IDENTIFIER_BYTES = 63;
const TESTNET_REST_HOST = "testnet.binance.vision";
const TESTNET_STREAM_HOST = "stream.testnet.binance.vision";
const TESTNET_WS_API_HOST = "ws-api.testnet.binance.vision";

function parseEnvFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    const values = new Map();

    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        const equalsIndex = line.indexOf("=");
        if (equalsIndex === -1) continue;

        const key = line.slice(0, equalsIndex).trim();
        let value = line.slice(equalsIndex + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values.set(key, value);
    }

    return values;
}

function byteLength(value) {
    return Buffer.byteLength(value || "", "utf8");
}

function decodeUrlPart(value) {
    try {
        return decodeURIComponent(value || "");
    } catch {
        return value || "";
    }
}

function assertPostgresIdentifier(name, value, errors) {
    if (!value) {
        errors.push(`${name} is required when using the bundled Postgres container.`);
        return;
    }

    if (byteLength(value) > MAX_POSTGRES_IDENTIFIER_BYTES) {
        errors.push(`${name} must be at most ${MAX_POSTGRES_IDENTIFIER_BYTES} bytes for PostgreSQL identifiers.`);
    }
}

function parseUrl(name, value, allowedProtocols, errors) {
    if (!value) return null;

    try {
        const parsed = new URL(value);
        if (allowedProtocols && !allowedProtocols.includes(parsed.protocol)) {
            errors.push(`${name} must use one of: ${allowedProtocols.join(", ")}.`);
        }
        return parsed;
    } catch {
        errors.push(`${name} must be a valid URL.`);
        return null;
    }
}

function requireString(values, name, errors) {
    const value = values.get(name);
    if (!value) errors.push(`${name} is required in .env.deploy.`);
    return value || "";
}

function validateOptionalBoolean(values, name, errors) {
    const value = values.get(name);
    if (!value) return;
    if (!["true", "false"].includes(value.toLowerCase())) {
        errors.push(`${name} must be true or false.`);
    }
}

function main() {
    const errors = [];

    if (!fs.existsSync(envPath)) {
        console.error("Deploy env validation failed:");
        console.error("- .env.deploy was not found. Copy .env.deploy.example to .env.deploy and fill required values.");
        process.exit(1);
    }

    const values = parseEnvFile(envPath);

    const jwtSecret = requireString(values, "JWT_SECRET", errors);
    if (jwtSecret && jwtSecret.length < 32) {
        errors.push("JWT_SECRET must be at least 32 characters.");
    }

    const encryptionKey = requireString(values, "ENCRYPTION_KEY", errors);
    if (encryptionKey && encryptionKey.length !== 32) {
        errors.push("ENCRYPTION_KEY must be exactly 32 characters.");
    }

    const postgresUser = values.get("TRADECO_POSTGRES_USER") || "tradeco";
    const postgresPassword = values.get("TRADECO_POSTGRES_PASSWORD") || "tradeco_change_me";
    const postgresDb = values.get("TRADECO_POSTGRES_DB") || "tradeco";

    assertPostgresIdentifier("TRADECO_POSTGRES_USER", postgresUser, errors);
    assertPostgresIdentifier("TRADECO_POSTGRES_DB", postgresDb, errors);

    const databaseUrl = values.get("DATABASE_URL");
    const parsedDatabaseUrl = parseUrl("DATABASE_URL", databaseUrl, ["postgresql:", "postgres:"], errors);
    if (parsedDatabaseUrl) {
        const databaseUser = decodeUrlPart(parsedDatabaseUrl.username);
        const databasePassword = decodeUrlPart(parsedDatabaseUrl.password);
        const databaseName = decodeUrlPart(parsedDatabaseUrl.pathname.replace(/^\//, ""));

        if (parsedDatabaseUrl.hostname === "postgres") {
            assertPostgresIdentifier("DATABASE_URL username", databaseUser, errors);
            assertPostgresIdentifier("DATABASE_URL database name", databaseName, errors);

            if (databaseUser !== postgresUser) {
                errors.push("DATABASE_URL username must match TRADECO_POSTGRES_USER when DATABASE_URL points to the bundled postgres service.");
            }
            if (databasePassword !== postgresPassword) {
                errors.push("DATABASE_URL password must match TRADECO_POSTGRES_PASSWORD when DATABASE_URL points to the bundled postgres service.");
            }
            if (databaseName !== postgresDb) {
                errors.push("DATABASE_URL database name must match TRADECO_POSTGRES_DB when DATABASE_URL points to the bundled postgres service.");
            }
        }
    }

    parseUrl("REDIS_URL", values.get("REDIS_URL"), ["redis:", "rediss:"], errors);

    const binanceApiBase = values.get("BINANCE_API_BASE");
    if (binanceApiBase) {
        const parsed = parseUrl("BINANCE_API_BASE", binanceApiBase, ["https:"], errors);
        if (parsed && parsed.hostname !== TESTNET_REST_HOST) {
            errors.push("BINANCE_API_BASE must remain on Binance Spot Testnet.");
        }
    }

    const binanceWsBase = values.get("BINANCE_WS_BASE");
    if (binanceWsBase) {
        const parsed = parseUrl("BINANCE_WS_BASE", binanceWsBase, ["wss:"], errors);
        if (parsed && parsed.hostname !== TESTNET_STREAM_HOST) {
            errors.push("BINANCE_WS_BASE must remain on Binance Spot Testnet streams.");
        }
    }

    const binanceWsApiBase = values.get("BINANCE_WS_API_BASE");
    if (binanceWsApiBase) {
        const parsed = parseUrl("BINANCE_WS_API_BASE", binanceWsApiBase, ["wss:"], errors);
        if (parsed && parsed.hostname !== TESTNET_WS_API_HOST) {
            errors.push("BINANCE_WS_API_BASE must remain on Binance Spot Testnet WebSocket API.");
        }
    }

    for (const name of [
        "NEXT_PUBLIC_BACKEND_URL",
        "NEXT_PUBLIC_API_URL",
        "NEXT_PUBLIC_EVENT_SERVICE_URL",
        "PUBLIC_APP_ORIGIN",
    ]) {
        parseUrl(name, values.get(name), ["http:", "https:"], errors);
    }
    parseUrl("NEXT_PUBLIC_WS_URL", values.get("NEXT_PUBLIC_WS_URL"), ["ws:", "wss:"], errors);
    validateOptionalBoolean(values, "NEXT_PUBLIC_ENABLE_ADVANCED_ORDERS", errors);

    if (errors.length > 0) {
        console.error("Deploy env validation failed:");
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    console.log("Deploy env validation passed.");
}

main();
