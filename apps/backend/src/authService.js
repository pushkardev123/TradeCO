import bcrypt from "bcrypt";
import { randomUUID } from "crypto";

import { encrypt } from "./crypto.js";
import { signAccessToken } from "./jwt.js";
import {
    generateRefreshToken,
    getRefreshTokenExpiresAt,
    hashRefreshToken,
    isRefreshSessionActive,
} from "./refreshToken.js";
import { BINANCE_TESTNET_EXCHANGE } from "./credentials.js";

const PASSWORD_HASH_ROUNDS = 12;
const CREDENTIAL_LABEL = "Binance Spot Testnet";

function authError(statusCode, message, code) {
    const err = new Error(message);
    err.statusCode = statusCode;
    err.code = code;
    return err;
}

export function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
}

export function getSessionMeta(req) {
    const userAgent = req?.get?.("user-agent") || req?.headers?.["user-agent"] || null;
    const ipAddress = req?.ip || req?.socket?.remoteAddress || null;
    return {
        userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
        ipAddress: ipAddress ? String(ipAddress).slice(0, 128) : null,
    };
}

function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
    };
}

function buildAuthResponse({ user, session, refreshToken }) {
    const accessToken = signAccessToken({ user, sessionId: session.id });
    return {
        accessToken,
        token: accessToken,
        refreshToken,
        session: {
            id: session.id,
            expiresAt: session.expiresAt,
        },
        user: publicUser(user),
    };
}

async function createRefreshSession(tx, userId, meta, familyId = randomUUID(), parentId = null) {
    const refreshToken = generateRefreshToken();
    const session = await tx.session.create({
        data: {
            userId,
            refreshTokenHash: hashRefreshToken(refreshToken),
            familyId,
            parentId,
            userAgent: meta?.userAgent || null,
            ipAddress: meta?.ipAddress || null,
            expiresAt: getRefreshTokenExpiresAt(),
        },
    });

    return { refreshToken, session };
}

export async function registerUser({ prisma, email, password, binanceApiKey, binanceSecretKey, meta }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password || !binanceApiKey || !binanceSecretKey) {
        throw authError(400, "Missing fields", "MISSING_FIELDS");
    }
    if (String(password).length < 6) {
        throw authError(400, "Password must be at least 6 characters", "WEAK_PASSWORD");
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
        throw authError(409, "Email already registered", "EMAIL_EXISTS");
    }

    const passwordHash = await bcrypt.hash(String(password), PASSWORD_HASH_ROUNDS);

    const { user, session, refreshToken } = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
            data: {
                email: normalizedEmail,
                passwordHash,
            },
            select: { id: true, email: true, createdAt: true },
        });

        await tx.exchangeCredential.create({
            data: {
                userId: createdUser.id,
                exchange: BINANCE_TESTNET_EXCHANGE,
                label: CREDENTIAL_LABEL,
                apiKeyEnc: encrypt(String(binanceApiKey)),
                secretKeyEnc: encrypt(String(binanceSecretKey)),
                isActive: true,
            },
        });

        const createdSession = await createRefreshSession(tx, createdUser.id, meta);
        return { user: createdUser, ...createdSession };
    });

    return buildAuthResponse({ user, session, refreshToken });
}

export async function loginUser({ prisma, email, password, meta }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
        throw authError(400, "Missing fields", "MISSING_FIELDS");
    }

    const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, email: true, passwordHash: true, createdAt: true },
    });
    if (!user) {
        throw authError(401, "Invalid credentials", "INVALID_CREDENTIALS");
    }

    const passwordOk = await bcrypt.compare(String(password), user.passwordHash);
    if (!passwordOk) {
        throw authError(401, "Invalid credentials", "INVALID_CREDENTIALS");
    }

    const { session, refreshToken } = await prisma.$transaction((tx) => createRefreshSession(tx, user.id, meta));
    return buildAuthResponse({ user, session, refreshToken });
}

export async function revokeSessionFamily(prisma, familyId, reason = "REFRESH_REUSE", now = new Date()) {
    await prisma.session.updateMany({
        where: {
            familyId,
            revokedAt: null,
        },
        data: {
            revokedAt: now,
            revokeReason: reason,
        },
    });
}

export async function refreshAuthSession({ prisma, refreshToken, meta }) {
    if (!refreshToken) {
        throw authError(401, "Refresh token required", "REFRESH_REQUIRED");
    }

    const now = new Date();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const session = await prisma.session.findUnique({
        where: { refreshTokenHash },
        include: {
            user: {
                select: { id: true, email: true, createdAt: true },
            },
        },
    });

    if (!session) {
        throw authError(401, "Invalid refresh token", "INVALID_REFRESH");
    }

    if (session.rotatedAt && !session.revokedAt) {
        await revokeSessionFamily(prisma, session.familyId, "REFRESH_REUSE", now);
        throw authError(401, "Invalid refresh token", "REFRESH_REUSE");
    }

    if (session.revokedAt) {
        throw authError(401, "Invalid refresh token", "REFRESH_REVOKED");
    }

    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
        await prisma.session.update({
            where: { id: session.id },
            data: { revokedAt: now, revokeReason: "EXPIRED" },
        });
        throw authError(401, "Invalid refresh token", "REFRESH_EXPIRED");
    }

    if (!isRefreshSessionActive(session, now)) {
        throw authError(401, "Invalid refresh token", "INVALID_REFRESH");
    }

    const nextRefreshToken = generateRefreshToken();
    const nextRefreshTokenHash = hashRefreshToken(nextRefreshToken);
    let racedReuse = false;

    try {
        const nextSession = await prisma.$transaction(async (tx) => {
            const claimed = await tx.session.updateMany({
                where: {
                    id: session.id,
                    rotatedAt: null,
                    revokedAt: null,
                    expiresAt: { gt: now },
                },
                data: {
                    rotatedAt: now,
                },
            });

            if (claimed.count !== 1) {
                racedReuse = true;
                throw authError(401, "Invalid refresh token", "REFRESH_REUSE");
            }

            const created = await tx.session.create({
                data: {
                    userId: session.userId,
                    refreshTokenHash: nextRefreshTokenHash,
                    familyId: session.familyId,
                    parentId: session.id,
                    userAgent: meta?.userAgent || session.userAgent || null,
                    ipAddress: meta?.ipAddress || session.ipAddress || null,
                    expiresAt: getRefreshTokenExpiresAt(now),
                },
            });

            await tx.session.update({
                where: { id: session.id },
                data: { replacedById: created.id },
            });

            return created;
        });

        return buildAuthResponse({ user: session.user, session: nextSession, refreshToken: nextRefreshToken });
    } catch (e) {
        if (racedReuse) {
            await revokeSessionFamily(prisma, session.familyId, "REFRESH_REUSE", now);
        }
        throw e;
    }
}

export async function logoutRefreshSession({ prisma, refreshToken, sessionId }) {
    const now = new Date();

    if (refreshToken) {
        const session = await prisma.session.findUnique({
            where: { refreshTokenHash: hashRefreshToken(refreshToken) },
        });
        if (!session) return false;

        await prisma.session.updateMany({
            where: {
                id: session.id,
                revokedAt: null,
            },
            data: {
                revokedAt: now,
                revokeReason: "LOGOUT",
            },
        });
        return true;
    }

    if (sessionId) {
        await prisma.session.updateMany({
            where: {
                id: sessionId,
                revokedAt: null,
            },
            data: {
                revokedAt: now,
                revokeReason: "LOGOUT",
            },
        });
        return true;
    }

    return false;
}

export async function getAuthenticatedUserContext({ prisma, userId, sessionId }) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, createdAt: true },
    });

    if (!user) {
        throw authError(404, "User not found", "USER_NOT_FOUND");
    }

    const credential = await prisma.exchangeCredential.findFirst({
        where: {
            userId,
            exchange: BINANCE_TESTNET_EXCHANGE,
            isActive: true,
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            exchange: true,
            label: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    return {
        user: publicUser(user),
        session: { id: sessionId },
        exchangeCredential: credential,
    };
}
