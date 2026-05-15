import jwt from "jsonwebtoken";
import { config } from "./config.js";

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

function accessTokenTtlSeconds() {
    const raw = Number(process.env.JWT_ACCESS_TTL_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
}

export function signAccessToken({ user, sessionId }) {
    return jwt.sign(
        {
            sub: user.id,
            sid: sessionId,
            email: user.email,
            roles: [],
        },
        config.jwtSecret,
        { expiresIn: accessTokenTtlSeconds() }
    );
}

export function verifyAccessToken(token) {
    const decoded = jwt.verify(token, config.jwtSecret);
    if (!decoded?.sub || !decoded?.sid) {
        const err = new Error("Token missing required claims");
        err.name = "JsonWebTokenError";
        throw err;
    }
    return decoded;
}

export function signToken(payload) {
    const userId = payload?.sub || payload?.userId || payload?.id;
    const sessionId = payload?.sid || payload?.sessionId;
    return signAccessToken({
        user: { id: userId, email: payload?.email || null },
        sessionId,
    });
}

export function verifyToken(token) {
    return verifyAccessToken(token);
}
