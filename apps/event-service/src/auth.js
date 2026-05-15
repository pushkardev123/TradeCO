import jwt from "jsonwebtoken";

export function authError(message, statusCode = 401) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

export function getBearerToken(req) {
    const header = String(req?.headers?.authorization || "");
    const [type, token] = header.split(" ");
    if (type !== "Bearer" || !token) return null;
    return token;
}

export function verifyAccessToken(token, jwtSecret) {
    const decoded = jwt.verify(token, jwtSecret);
    if (!decoded?.sub || !decoded?.sid) {
        throw authError("Token missing required claims");
    }

    return {
        id: String(decoded.sub),
        sessionId: String(decoded.sid),
        email: decoded.email || null,
    };
}

export function hasUserIdParam(url) {
    return url.searchParams.has("userId") || url.searchParams.has("user_id");
}

export function getUserIdParam(url) {
    if (!hasUserIdParam(url)) return null;
    return url.searchParams.get("userId") ?? url.searchParams.get("user_id") ?? "";
}

export function getMessageUserId(message) {
    try {
        let payload = JSON.parse(message);
        if (typeof payload === "string") payload = JSON.parse(payload);
        return payload?.userId ? String(payload.userId) : null;
    } catch {
        return null;
    }
}

export function isScopedChannel(channel, scopedChannels) {
    return scopedChannels.includes(channel);
}

export function shouldBroadcastChannelMessage({ channel, message, scopedChannels }) {
    const scopedUserId = getMessageUserId(message);
    return !isScopedChannel(channel, scopedChannels) || Boolean(scopedUserId);
}

export function canReceiveBroadcast({ ws, channel, message, scopedChannels }) {
    const scopedUserId = getMessageUserId(message);
    if (isScopedChannel(channel, scopedChannels) && !scopedUserId) return false;
    if (scopedUserId && ws?.user?.id !== scopedUserId) return false;
    return true;
}
