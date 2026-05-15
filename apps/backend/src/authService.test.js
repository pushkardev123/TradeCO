import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = "test-jwt-secret-for-auth-service";
process.env.ENCRYPTION_KEY = "12345678901234567890123456789012";
process.env.JWT_ACCESS_TTL_SECONDS = "900";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/tradeco_test";
process.env.REDIS_URL = "redis://localhost:6379";

const {
    getAuthenticatedUserContext,
    loginUser,
    logoutRefreshSession,
    refreshAuthSession,
    registerUser,
} = await import("./authService.js");
const { decrypt } = await import("./crypto.js");
const { verifyAccessToken } = await import("./jwt.js");

class MemoryPrisma {
    constructor() {
        this.users = [];
        this.sessions = [];
        this.exchangeCredentials = [];
        this.ids = { user: 0, session: 0, credential: 0 };

        this.user = {
            findUnique: (args) => this.findUser(args),
            create: (args) => this.createUser(args),
        };
        this.session = {
            create: (args) => this.createSession(args),
            findUnique: (args) => this.findSession(args),
            update: (args) => this.updateSession(args),
            updateMany: (args) => this.updateManySessions(args),
        };
        this.exchangeCredential = {
            create: (args) => this.createExchangeCredential(args),
            findFirst: (args) => this.findExchangeCredential(args),
        };
    }

    async $transaction(fn) {
        return fn(this);
    }

    applySelect(row, select) {
        if (!row || !select) return row ? { ...row } : null;
        const out = {};
        for (const key of Object.keys(select)) {
            if (select[key] === true) out[key] = row[key];
        }
        return out;
    }

    matches(row, where = {}) {
        return Object.entries(where).every(([key, expected]) => {
            if (expected === null) return row[key] === null || row[key] === undefined;
            if (expected && typeof expected === "object" && "gt" in expected) {
                return new Date(row[key]).getTime() > new Date(expected.gt).getTime();
            }
            return row[key] === expected;
        });
    }

    async findUser({ where, select }) {
        const user = this.users.find((row) => (
            (where.id && row.id === where.id) ||
            (where.email && row.email === where.email)
        ));
        return this.applySelect(user, select);
    }

    async createUser({ data, select }) {
        if (this.users.some((row) => row.email === data.email)) {
            const err = new Error("Unique constraint failed");
            err.code = "P2002";
            throw err;
        }

        const now = new Date();
        const user = {
            id: `user_${++this.ids.user}`,
            email: data.email,
            passwordHash: data.passwordHash,
            createdAt: now,
        };
        this.users.push(user);
        return this.applySelect(user, select);
    }

    async createExchangeCredential({ data, select }) {
        const now = new Date();
        const credential = {
            id: `cred_${++this.ids.credential}`,
            createdAt: now,
            updatedAt: now,
            ...data,
        };
        this.exchangeCredentials.push(credential);
        return this.applySelect(credential, select);
    }

    async findExchangeCredential({ where, select, orderBy }) {
        const rows = this.exchangeCredentials
            .filter((row) => this.matches(row, where))
            .sort((a, b) => {
                if (orderBy?.createdAt === "desc") return b.createdAt.getTime() - a.createdAt.getTime();
                return a.createdAt.getTime() - b.createdAt.getTime();
            });
        return this.applySelect(rows[0], select);
    }

    async createSession({ data, select }) {
        const now = new Date();
        const session = {
            id: `session_${++this.ids.session}`,
            parentId: null,
            replacedById: null,
            rotatedAt: null,
            revokedAt: null,
            revokeReason: null,
            createdAt: now,
            updatedAt: now,
            ...data,
        };
        this.sessions.push(session);
        return this.applySelect(session, select);
    }

    async findSession({ where, include, select }) {
        const session = this.sessions.find((row) => (
            (where.id && row.id === where.id) ||
            (where.refreshTokenHash && row.refreshTokenHash === where.refreshTokenHash)
        ));
        if (!session) return null;

        const out = this.applySelect(session, select);
        if (include?.user) {
            const user = this.users.find((row) => row.id === session.userId);
            out.user = this.applySelect(user, include.user.select);
        }
        return out;
    }

    async updateSession({ where, data }) {
        const session = this.sessions.find((row) => row.id === where.id);
        if (!session) throw new Error("Session not found");
        Object.assign(session, data, { updatedAt: new Date() });
        return { ...session };
    }

    async updateManySessions({ where, data }) {
        let count = 0;
        for (const session of this.sessions) {
            if (!this.matches(session, where)) continue;
            Object.assign(session, data, { updatedAt: new Date() });
            count += 1;
        }
        return { count };
    }
}

function meta() {
    return { userAgent: "node-test", ipAddress: "127.0.0.1" };
}

test("register creates User, ExchangeCredential, hashed Session, and short access token", async () => {
    const prisma = new MemoryPrisma();

    const auth = await registerUser({
        prisma,
        email: " Alice@Example.COM ",
        password: "password123",
        binanceApiKey: "test-api-key",
        binanceSecretKey: "test-secret-key",
        meta: meta(),
    });

    assert.equal(auth.user.email, "alice@example.com");
    assert.equal(auth.accessToken, auth.token);
    assert.equal(prisma.users.length, 1);
    assert.equal(prisma.users[0].binanceApiKeyEnc, undefined);
    assert.equal(prisma.exchangeCredentials.length, 1);
    assert.equal(decrypt(prisma.exchangeCredentials[0].apiKeyEnc), "test-api-key");
    assert.equal(decrypt(prisma.exchangeCredentials[0].secretKeyEnc), "test-secret-key");
    assert.notEqual(prisma.exchangeCredentials[0].apiKeyEnc, "test-api-key");
    assert.equal(prisma.sessions.length, 1);
    assert.match(prisma.sessions[0].refreshTokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(prisma.sessions[0].refreshTokenHash, auth.refreshToken);

    const decoded = verifyAccessToken(auth.accessToken);
    assert.equal(decoded.sub, auth.user.id);
    assert.equal(decoded.sid, auth.session.id);
    assert.ok(decoded.exp - decoded.iat <= 900);
});

test("login issues a new refresh session and rejects invalid credentials", async () => {
    const prisma = new MemoryPrisma();
    await registerUser({
        prisma,
        email: "alice@example.com",
        password: "password123",
        binanceApiKey: "test-api-key",
        binanceSecretKey: "test-secret-key",
        meta: meta(),
    });

    const login = await loginUser({ prisma, email: "alice@example.com", password: "password123", meta: meta() });
    assert.equal(login.user.email, "alice@example.com");
    assert.equal(prisma.sessions.length, 2);

    await assert.rejects(
        () => loginUser({ prisma, email: "alice@example.com", password: "wrong-password", meta: meta() }),
        /Invalid credentials/
    );
});

test("refresh rotates token and reuse revokes the session family", async () => {
    const prisma = new MemoryPrisma();
    await registerUser({
        prisma,
        email: "alice@example.com",
        password: "password123",
        binanceApiKey: "test-api-key",
        binanceSecretKey: "test-secret-key",
        meta: meta(),
    });
    const login = await loginUser({ prisma, email: "alice@example.com", password: "password123", meta: meta() });

    const rotated = await refreshAuthSession({ prisma, refreshToken: login.refreshToken, meta: meta() });
    const oldSession = prisma.sessions.find((row) => row.id === login.session.id);
    const newSession = prisma.sessions.find((row) => row.id === rotated.session.id);

    assert.ok(oldSession.rotatedAt);
    assert.equal(oldSession.replacedById, newSession.id);
    assert.equal(newSession.parentId, oldSession.id);
    assert.equal(newSession.familyId, oldSession.familyId);

    await assert.rejects(
        () => refreshAuthSession({ prisma, refreshToken: login.refreshToken, meta: meta() }),
        /Invalid refresh token/
    );

    const familySessions = prisma.sessions.filter((row) => row.familyId === oldSession.familyId);
    assert.equal(familySessions.every((row) => row.revokedAt), true);
    assert.equal(familySessions.every((row) => row.revokeReason === "REFRESH_REUSE"), true);
    await assert.rejects(
        () => refreshAuthSession({ prisma, refreshToken: rotated.refreshToken, meta: meta() }),
        /Invalid refresh token/
    );
});

test("logout revokes active refresh session", async () => {
    const prisma = new MemoryPrisma();
    await registerUser({
        prisma,
        email: "alice@example.com",
        password: "password123",
        binanceApiKey: "test-api-key",
        binanceSecretKey: "test-secret-key",
        meta: meta(),
    });
    const login = await loginUser({ prisma, email: "alice@example.com", password: "password123", meta: meta() });

    const revoked = await logoutRefreshSession({ prisma, refreshToken: login.refreshToken });
    assert.equal(revoked, true);
    const session = prisma.sessions.find((row) => row.id === login.session.id);
    assert.ok(session.revokedAt);
    assert.equal(session.revokeReason, "LOGOUT");

    await assert.rejects(
        () => refreshAuthSession({ prisma, refreshToken: login.refreshToken, meta: meta() }),
        /Invalid refresh token/
    );
});

test("me context excludes encrypted credential payloads", async () => {
    const prisma = new MemoryPrisma();
    const auth = await registerUser({
        prisma,
        email: "alice@example.com",
        password: "password123",
        binanceApiKey: "test-api-key",
        binanceSecretKey: "test-secret-key",
        meta: meta(),
    });

    const context = await getAuthenticatedUserContext({
        prisma,
        userId: auth.user.id,
        sessionId: auth.session.id,
    });

    assert.equal(context.user.email, "alice@example.com");
    assert.equal(context.session.id, auth.session.id);
    assert.equal(context.exchangeCredential.exchange, "BINANCE_SPOT_TESTNET");
    assert.equal(context.exchangeCredential.apiKeyEnc, undefined);
    assert.equal(context.exchangeCredential.secretKeyEnc, undefined);
});
