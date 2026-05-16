import { randomUUID } from "node:crypto";

const LEVELS = Object.freeze({
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
});

const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|password|secret|signature|token|credential|api[_-]?key|apikey|jwt|refresh)/i;
const JWT_PATTERN = /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
const SIGNATURE_QUERY_PATTERN = /([?&]signature=)[^&\s]+/gi;

export function createLogger({ service, level = process.env.LOG_LEVEL || "info", context = {}, sink } = {}) {
    const serviceName = normalizeString(service) || "tradeco";
    const minLevel = LEVELS[normalizeLevel(level)] ?? LEVELS.info;
    const baseContext = sanitizeLogFields(context);
    const write = typeof sink === "function" ? sink : defaultSink;

    function emit(logLevel, message, fields = {}) {
        const normalizedLevel = normalizeLevel(logLevel);
        if ((LEVELS[normalizedLevel] ?? LEVELS.info) < minLevel) return;

        const entry = sanitizeLogFields({
            ts: new Date().toISOString(),
            level: normalizedLevel,
            service: serviceName,
            msg: normalizeString(message) || "event",
            ...baseContext,
            ...fields,
        });

        write(JSON.stringify(entry), entry);
    }

    return {
        log(message, fields) {
            emit("info", message, fields);
        },
        debug(message, fields) {
            emit("debug", message, fields);
        },
        info(message, fields) {
            emit("info", message, fields);
        },
        warn(message, fields) {
            emit("warn", message, fields);
        },
        error(message, fields) {
            emit("error", message, fields);
        },
        child(childContext = {}) {
            return createLogger({
                service: serviceName,
                level,
                context: {
                    ...baseContext,
                    ...sanitizeLogFields(childContext),
                },
                sink: write,
            });
        },
    };
}

export function createRequestContext(headers = {}) {
    const requestId = normalizeHeader(headers, "x-request-id") || randomUUID();
    const traceId = normalizeHeader(headers, "x-trace-id") || requestId;
    return { requestId, traceId };
}

export function setTraceHeaders(res, context = {}) {
    if (!res || typeof res.setHeader !== "function") return;
    if (context.requestId) res.setHeader("X-Request-Id", context.requestId);
    if (context.traceId) res.setHeader("X-Trace-Id", context.traceId);
}

export function durationMs(startedAt) {
    return Math.max(0, Date.now() - Number(startedAt || Date.now()));
}

export function safeError(error) {
    if (!error) return { message: "Unknown error" };
    return sanitizeLogFields({
        name: error.name,
        code: error.code,
        message: error.message || String(error),
        statusCode: error.statusCode,
    });
}

export function sanitizeLogFields(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;

    if (typeof value === "string") {
        return sanitizeString(value);
    }

    if (typeof value !== "object") {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (seen.has(value)) {
        return "[circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeLogFields(item, seen));
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, fieldValue]) => {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
                return [key, "[redacted]"];
            }
            return [key, sanitizeLogFields(fieldValue, seen)];
        }),
    );
}

export function redactUrl(value) {
    try {
        const parsed = new URL(String(value || ""));
        if (parsed.username || parsed.password) {
            parsed.username = "<redacted>";
            parsed.password = "";
        }
        parsed.search = "";
        return parsed.toString().replace("%3Credacted%3E", "<redacted>");
    } catch {
        return "<invalid-url>";
    }
}

function normalizeHeader(headers, name) {
    const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
    const selected = Array.isArray(value) ? value[0] : value;
    return normalizeString(selected);
}

function normalizeString(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

function normalizeLevel(value) {
    const level = normalizeString(value).toLowerCase();
    return LEVELS[level] === undefined ? "info" : level;
}

function sanitizeString(value) {
    return value
        .replace(JWT_PATTERN, "[redacted-jwt]")
        .replace(SIGNATURE_QUERY_PATTERN, "$1[redacted]");
}

function defaultSink(line, entry) {
    if (entry.level === "error") {
        console.error(line);
        return;
    }
    if (entry.level === "warn") {
        console.warn(line);
        return;
    }
    console.log(line);
}
