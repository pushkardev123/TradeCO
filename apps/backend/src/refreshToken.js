import crypto from "crypto";

const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;
const REFRESH_TOKEN_BYTES = 32;

function numberFromEnv(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const REFRESH_TOKEN_TTL_DAYS = numberFromEnv("REFRESH_TOKEN_TTL_DAYS", DEFAULT_REFRESH_TOKEN_TTL_DAYS);

export function generateRefreshToken() {
    return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

export function hashRefreshToken(token) {
    return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function getRefreshTokenExpiresAt(now = new Date()) {
    return new Date(now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isRefreshSessionActive(session, now = new Date()) {
    return Boolean(
        session &&
        !session.rotatedAt &&
        !session.revokedAt &&
        new Date(session.expiresAt).getTime() > now.getTime()
    );
}
