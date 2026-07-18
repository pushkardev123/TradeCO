import { REFRESH_TOKEN_TTL_DAYS } from "./refreshToken.js";

export const REFRESH_COOKIE_NAME = process.env.REFRESH_COOKIE_NAME || "tradeco_refresh";

// Must match the public URL path the browser uses, not the backend's internal
// route. Behind a proxy that maps /api/ -> backend /, set this to /api/auth or
// the browser will scope the cookie to /auth and never send it back.
export const REFRESH_COOKIE_PATH = process.env.REFRESH_COOKIE_PATH || "/auth";

function parseCookies(header) {
    const out = {};
    for (const part of String(header || "").split(";")) {
        const idx = part.indexOf("=");
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!key) continue;
        out[key] = decodeURIComponent(value);
    }
    return out;
}

function boolFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    return raw === "1" || raw.toLowerCase() === "true";
}

export function getRefreshTokenFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie);
    const cookieToken = cookies[REFRESH_COOKIE_NAME];
    const bodyToken = req.body?.refreshToken;

    if (typeof cookieToken === "string" && cookieToken.length > 0) return cookieToken;
    if (typeof bodyToken === "string" && bodyToken.length > 0) return bodyToken;
    return null;
}

export function setRefreshCookie(res, refreshToken) {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
        httpOnly: true,
        secure: boolFromEnv("AUTH_COOKIE_SECURE", process.env.NODE_ENV === "production"),
        sameSite: process.env.AUTH_COOKIE_SAME_SITE || "lax",
        maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        path: REFRESH_COOKIE_PATH,
    });
}

export function clearRefreshCookie(res) {
    res.clearCookie(REFRESH_COOKIE_NAME, {
        httpOnly: true,
        secure: boolFromEnv("AUTH_COOKIE_SECURE", process.env.NODE_ENV === "production"),
        sameSite: process.env.AUTH_COOKIE_SAME_SITE || "lax",
        path: REFRESH_COOKIE_PATH,
    });
}
