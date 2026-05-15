import crypto from "crypto";

export const BINANCE_SPOT_TESTNET_WS_API_BASE = "wss://ws-api.testnet.binance.vision/ws-api/v3";
export const USER_DATA_STREAM_SUBSCRIBE_METHOD = "userDataStream.subscribe.signature";
export const USER_DATA_STREAM_UNSUBSCRIBE_METHOD = "userDataStream.unsubscribe";

export function normalizeBinanceWsApiBase(value = BINANCE_SPOT_TESTNET_WS_API_BASE) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("BINANCE_WS_API_BASE must be a valid Binance Spot Testnet WebSocket API URL");
    }

    if (parsed.protocol !== "wss:") {
        throw new Error("BINANCE_WS_API_BASE must use wss for Binance Spot Testnet WebSocket API");
    }

    if (parsed.hostname.toLowerCase() !== "ws-api.testnet.binance.vision") {
        throw new Error("BINANCE_WS_API_BASE must point to Binance Spot Testnet WebSocket API");
    }

    const pathname = parsed.pathname.replace(/\/$/, "");
    if (pathname !== "/ws-api/v3") {
        throw new Error("BINANCE_WS_API_BASE path must be /ws-api/v3");
    }

    return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function buildUserDataStreamSubscribeRequest({
    apiKey,
    secretKey,
    timestamp = Date.now(),
    recvWindow = 5000,
    id = createUserDataStreamRequestId(timestamp),
} = {}) {
    const params = {
        apiKey: requiredString(apiKey, "apiKey"),
        timestamp: normalizeTimestamp(timestamp),
    };

    if (recvWindow !== undefined && recvWindow !== null) {
        params.recvWindow = normalizeRecvWindow(recvWindow);
    }

    params.signature = signWebSocketApiParams(params, secretKey);

    return {
        id: requiredString(id, "id"),
        method: USER_DATA_STREAM_SUBSCRIBE_METHOD,
        params,
    };
}

export function buildUserDataStreamUnsubscribeRequest({
    subscriptionId,
    id = createUserDataStreamRequestId(Date.now()),
} = {}) {
    const params = {};
    if (subscriptionId !== undefined && subscriptionId !== null && subscriptionId !== "") {
        params.subscriptionId = subscriptionId;
    }

    return {
        id: requiredString(id, "id"),
        method: USER_DATA_STREAM_UNSUBSCRIBE_METHOD,
        params,
    };
}

export function signWebSocketApiParams(params, secretKey) {
    const payload = serializeWebSocketApiSigningPayload(params);
    return signWebSocketApiPayload(payload, secretKey);
}

export function serializeWebSocketApiSigningPayload(params = {}) {
    return Object.keys(params)
        .filter((key) => key !== "signature" && params[key] !== undefined && params[key] !== null)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
}

export function signWebSocketApiPayload(payload, secretKey) {
    const normalizedSecret = requiredString(secretKey, "secretKey");
    const signingPayload = String(payload || "");

    try {
        const privateKey = crypto.createPrivateKey(normalizedSecret);
        const algorithm = privateKey.asymmetricKeyType === "ed25519" ? null : "RSA-SHA256";
        return crypto.sign(algorithm, Buffer.from(signingPayload), privateKey).toString("base64");
    } catch {
        return crypto.createHmac("sha256", normalizedSecret).update(signingPayload).digest("hex");
    }
}

export function parseUserDataStreamMessage(raw) {
    let parsed;
    try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString());
    } catch {
        return { kind: "invalid", raw: null, event: null };
    }

    if (parsed?.event && typeof parsed.event === "object") {
        return { kind: "event", raw: parsed, event: parsed.event, subscriptionId: parsed.subscriptionId ?? null };
    }

    if (parsed?.e) {
        return { kind: "event", raw: parsed, event: parsed, subscriptionId: null };
    }

    if (parsed?.status !== undefined || parsed?.id !== undefined) {
        return { kind: "response", raw: parsed, event: null };
    }

    return { kind: "unknown", raw: parsed, event: null };
}

export function isUserDataStreamSubscribeAck(message, requestId) {
    const parsed = message?.raw || message;
    return parsed?.id === requestId
        && Number(parsed?.status) === 200
        && parsed?.result
        && parsed.result.subscriptionId !== undefined
        && parsed.result.subscriptionId !== null;
}

export function getUserDataStreamSubscriptionId(message) {
    const parsed = message?.raw || message;
    return parsed?.result?.subscriptionId ?? null;
}

function createUserDataStreamRequestId(timestamp) {
    return `uds-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error("timestamp must be a positive number");
    }
    return Math.trunc(timestamp);
}

function normalizeRecvWindow(value) {
    const recvWindow = Number(value);
    if (!Number.isFinite(recvWindow) || recvWindow <= 0) {
        throw new Error("recvWindow must be a positive number");
    }
    return recvWindow;
}

function requiredString(value, name) {
    const normalized = String(value || "").trim();
    if (!normalized) {
        throw new Error(`${name} is required`);
    }
    return normalized;
}
