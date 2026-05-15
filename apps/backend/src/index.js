import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";
import { randomUUID } from "crypto";

import { encrypt } from "./crypto.js";
import { signToken } from "./jwt.js";
import { requireAuth } from "./middleware.js";
import { getAccountInfo } from "./binance.js";
import { decrypt } from "./crypto.js";

const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL;
const COMMANDS_CHANNEL = process.env.COMMANDS_CHANNEL || "commands:order:submit";

if (!REDIS_URL) {
    console.error("[backend] REDIS_URL missing");
    process.exit(1);
}

const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json());

const redis = createClient({ url: REDIS_URL });
redis.on("error", (e) => console.error("[backend] redis error:", e));

function hasUserIdField(value) {
    return Boolean(
        value &&
        typeof value === "object" &&
        (Object.prototype.hasOwnProperty.call(value, "userId") ||
            Object.prototype.hasOwnProperty.call(value, "user_id"))
    );
}

function getClientUserId(value) {
    if (!hasUserIdField(value)) return null;
    return value.userId ?? value.user_id ?? "";
}

function rejectClientUserId(req, res) {
    const supplied = [req.query, req.body, req.body?.meta]
        .map(getClientUserId)
        .find((value) => value !== null);

    if (supplied === undefined) return false;

    const suppliedUserId = String(supplied || "");
    if (suppliedUserId && suppliedUserId !== req.user?.id) {
        res.status(403).json({
            ok: false,
            error: "userId does not match the authenticated user",
        });
        return true;
    }

    res.status(403).json({
        ok: false,
        error: "userId is derived from the access token and is not accepted in requests",
    });
    return true;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "backend" }));

// -------- POSITIONS (UI pagination) --------
// Cursor-based pagination by Position.id (newest updated first)
// Response shape expected by frontend: { ok: true, items: [...], nextCursor }
app.get("/positions", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const limitRaw = Number(req.query?.limit);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 10;
        const cursor = req.query?.cursor ? String(req.query.cursor) : null;

        const totalEntries = await prisma.position.count({ where: { userId: req.user.id } });
        const totalPages = Math.max(1, Math.ceil(totalEntries / limit));

        const rows = await prisma.position.findMany({
            where: { userId: req.user.id },
            orderBy: { updatedAt: "desc" },
            ...(cursor
                ? {
                    cursor: { id: cursor },
                    skip: 1,
                }
                : {}),
            take: limit,
        });

        if (rows.length === 0) {
            return res.json({ ok: true, items: [], nextCursor: null, totalEntries, totalPages });
        }

        const items = rows.map((p) => ({
            id: p.id,
            symbol: p.symbol,
            quantity: p.quantity,
            avgPrice: p.avgPrice,
            realizedPnl: p.realizedPnl,
            updatedAt: p.updatedAt?.toISOString?.() || p.updatedAt,
            createdAt: p.createdAt?.toISOString?.() || p.createdAt,
        }));

        const nextCursor = rows.length === limit ? (rows[rows.length - 1]?.id || null) : null;
        return res.json({ ok: true, items, nextCursor, totalEntries, totalPages });
    } catch (e) {
        const msg = String(e?.message || "");
        if (msg.includes("Record to fetch does not exist") || msg.includes("not found")) {
            const totalEntries = await prisma.position.count({ where: { userId: req.user.id } });
            const totalPages = Math.max(1, Math.ceil(totalEntries / 10));
            return res.json({ ok: true, items: [], nextCursor: null, totalEntries, totalPages });
        }
        console.error("[backend] /positions error:", e);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

// -------- ORDERS (UI pagination) --------
// Cursor-based pagination by orderId (newest first)
// Response shape expected by frontend: { ok: true, items: [...], nextCursor }
app.get("/orders", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const limitRaw = Number(req.query?.limit);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 10;
        const cursor = req.query?.cursor ? String(req.query.cursor) : null;

        // Total entries for pagination UI
        const totalEntries = await prisma.orderCommand.count({ where: { userId: req.user.id } });
        const totalPages = Math.max(1, Math.ceil(totalEntries / limit));

        // Page of commands (newest first). Use cursor if provided.
        const commands = await prisma.orderCommand.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: "desc" },
            ...(cursor
                ? {
                    cursor: { orderId: cursor },
                    skip: 1,
                }
                : {}),
            take: limit,
        });

        if (commands.length === 0) {
            return res.json({ ok: true, items: [], nextCursor: null, totalEntries, totalPages });
        }

        const orderIds = commands.map((c) => c.orderId);

        // Fetch latest events for these orders (we will pick the newest per orderId)
        const events = await prisma.orderEvent.findMany({
            where: {
                userId: req.user.id,
                orderId: { in: orderIds },
            },
            orderBy: { timestamp: "desc" },
        });

        const latestByOrderId = new Map();
        for (const ev of events) {
            if (!latestByOrderId.has(ev.orderId)) {
                latestByOrderId.set(ev.orderId, ev);
            }
        }

        const items = commands.map((c) => {
            const latest = latestByOrderId.get(c.orderId);
            return {
                orderId: c.orderId,
                symbol: c.symbol,
                side: c.side,
                orderType: c.type,
                quantity: c.quantity,
                status: latest?.status || c.status,
                price: latest?.price ?? null,
                timestamp: (latest?.timestamp || c.createdAt)?.toISOString?.() || latest?.timestamp || c.createdAt,
                createdAt: c.createdAt?.toISOString?.() || c.createdAt,
                // Include rejection info if your schema has it later (e.g. rejectReason)
            };
        });

        const nextCursor = commands.length === limit ? (commands[commands.length - 1]?.orderId || null) : null;
        return res.json({ ok: true, items, nextCursor, totalEntries, totalPages });
    } catch (e) {
        // Prisma throws if cursor orderId doesn’t exist; treat that as empty pagination
        const msg = String(e?.message || "");
        if (msg.includes("Record to fetch does not exist") || msg.includes("not found")) {
            // Totals still useful even if the cursor is stale
            const totalEntries = await prisma.orderCommand.count({ where: { userId: req.user.id } });
            const totalPages = Math.max(1, Math.ceil(totalEntries / 10));
            return res.json({ ok: true, items: [], nextCursor: null, totalEntries, totalPages });
        }
        console.error(e);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});


app.post("/orders", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const body = req.body || {};
        const symbol = String(body.symbol || "").toUpperCase();
        const side = String(body.side || "").toUpperCase();
        const quantity = Number(body.quantity);
        const orderType = String(body.orderType || "MARKET").toUpperCase();

        if (!symbol) {
            return res.status(400).json({ ok: false, error: "symbol is required" });
        }
        if (side !== "BUY" && side !== "SELL") {
            return res.status(400).json({ ok: false, error: "side must be BUY or SELL" });
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return res.status(400).json({ ok: false, error: "quantity must be > 0" });
        }

        if (orderType === "LIMIT") {
            const price = Number(body.price);
            if (!Number.isFinite(price) || price <= 0) {
                return res.status(400).json({ ok: false, error: "LIMIT requires a valid price" });
            }
        }

        if (orderType === "STOP_MARKET" || orderType === "STOP_LOSS" || orderType === "TAKE_PROFIT") {
            const stopPrice = Number(body.stopPrice);
            if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
                return res.status(400).json({ ok: false, error: `${orderType} requires a valid stopPrice` });
            }
        }

        if (orderType === "STOP_LOSS_LIMIT" || orderType === "TAKE_PROFIT_LIMIT") {
            const stopPrice = Number(body.stopPrice);
            const price = Number(body.price);
            const timeInForce = String(body.timeInForce || "").toUpperCase();

            if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
                return res.status(400).json({ ok: false, error: `${orderType} requires a valid stopPrice` });
            }
            if (!Number.isFinite(price) || price <= 0) {
                return res.status(400).json({ ok: false, error: `${orderType} requires a valid price` });
            }
            if (!timeInForce) {
                return res.status(400).json({ ok: false, error: `${orderType} requires timeInForce` });
            }
        }

        const orderId = String(body.orderId || body.id || randomUUID());
        const command = {
            type: "ORDER_CREATED",
            orderId,
            userId: req.user.id,
            symbol,
            side,
            quantity,
            orderType,
            price: body.price,
            stopPrice: body.stopPrice,
            timeInForce: body.timeInForce,
            meta: body.meta || {},
            ts: Date.now(),
        };

        await prisma.orderCommand.create({
            data: {
                userId: req.user.id,
                orderId,
                symbol,
                side,
                type: orderType,
                quantity,
                price: body.price === undefined || body.price === null || body.price === "" ? null : Number(body.price),
                stopPrice: body.stopPrice === undefined || body.stopPrice === null || body.stopPrice === "" ? null : Number(body.stopPrice),
                timeInForce: body.timeInForce ? String(body.timeInForce).toUpperCase() : null,
                status: "RECEIVED",
            },
        });

        await redis.publish(COMMANDS_CHANNEL, JSON.stringify(command));

        return res.json({ ok: true, orderId, status: "PENDING" });
    } catch (e) {
        if (e?.code === "P2002") {
            return res.status(409).json({ ok: false, error: "orderId already exists" });
        }
        console.error("[backend] /orders create error:", e);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

// -------- AUTH --------

app.post("/auth/register", async (req, res) => {
    try {
        const { email, password, binanceApiKey, binanceSecretKey } = req.body || {};

        if (!email || !password || !binanceApiKey || !binanceSecretKey) {
            return res.status(400).json({ ok: false, error: "Missing fields" });
        }

        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            return res.status(409).json({ ok: false, error: "Email already registered" });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                binanceApiKeyEnc: encrypt(binanceApiKey),
                binanceSecretKeyEnc: encrypt(binanceSecretKey)
            },
            select: { id: true, email: true, createdAt: true }
        });

        const token = signToken({ userId: user.id, email: user.email });

        return res.json({ ok: true, token, user });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

app.post("/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ ok: false, error: "Missing fields" });
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

        const token = signToken({ userId: user.id, email: user.email });

        return res.json({ ok: true, token, user: { id: user.id, email: user.email } });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

// -------- TRADING (Phase 3 uses this; we can add now) --------
// This is the real replacement for /dev/publish-test later.
// It publishes command to Redis, DOES NOT call Binance.
// app.post("/api/trading/orders", requireAuth, async (req, res) => {
//     const { symbol, side, type, quantity } = req.body || {};
//     if (!symbol || !side || !type || !quantity) {
//         return res.status(400).json({ ok: false, error: "Missing fields" });
//     }

//     const cmd = {
//         orderId: randomUUID(),
//         userId: req.user.id,
//         symbol,
//         side,
//         type,
//         quantity: String(quantity),
//         ts: Date.now()
//     };

//     await prisma.orderCommand.create({
//         data: {
//             userId: req.user.id,
//             orderId: cmd.orderId,
//             symbol: cmd.symbol,
//             side: cmd.side,
//             type: cmd.type,
//             quantity: Number(cmd.quantity),
//             status: "RECEIVED",
//         },
//     });

//     await redis.publish(COMMANDS_CHANNEL, JSON.stringify(cmd));

//     return res.json({ ok: true, orderId: cmd.orderId, status: "PENDING" });
// });

app.get("/api/trading/positions", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        // Pull FILLED events
        const filledEvents = await prisma.orderEvent.findMany({
            where: { userId: req.user.id, status: "FILLED" },
            select: { orderId: true, quantity: true },
        });

        if (filledEvents.length === 0) {
            return res.json({ ok: true, positions: [] });
        }

        const filledOrderIds = [...new Set(filledEvents.map((e) => e.orderId))];

        // Fetch the corresponding commands to get symbol + side
        const commands = await prisma.orderCommand.findMany({
            where: {
                userId: req.user.id,
                orderId: { in: filledOrderIds },
            },
            select: { orderId: true, symbol: true, side: true },
        });

        const cmdByOrderId = new Map(commands.map((c) => [c.orderId, c]));

        // Aggregate net quantity per symbol
        const qtyBySymbol = new Map();

        for (const ev of filledEvents) {
            const cmd = cmdByOrderId.get(ev.orderId);
            if (!cmd) continue;

            const q = Number(ev.quantity ?? 0);
            const signed = cmd.side === "BUY" ? q : -q;
            qtyBySymbol.set(cmd.symbol, (qtyBySymbol.get(cmd.symbol) || 0) + signed);
        }

        const positions = Array.from(qtyBySymbol.entries()).map(([symbol, quantity]) => ({
            symbol,
            quantity,
        }));

        return res.json({ ok: true, positions });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

// Keep your dev hook if you want (helpful during development)
if (process.env.NODE_ENV !== "production") {
    app.post("/dev/publish-test", requireAuth, async (req, res) => {
        if (rejectClientUserId(req, res)) return;

        const cmd = {
            orderId: randomUUID(),
            userId: req.user.id,
            symbol: "BTCUSDT",
            side: "BUY",
            type: "MARKET",
            quantity: "0.01",
            ts: Date.now()
        };

        await redis.publish(COMMANDS_CHANNEL, JSON.stringify(cmd));
        res.json({ ok: true, message: "command published", cmd });
    });
}

app.get("/api/trading/account", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        // 1) fetch encrypted keys from DB
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { binanceApiKeyEnc: true, binanceSecretKeyEnc: true },
        });

        if (!user) {
            return res.status(404).json({ ok: false, error: "User not found" });
        }

        // decrypt keys
        const apiKey = decrypt(user.binanceApiKeyEnc);
        const apiSecret = decrypt(user.binanceSecretKeyEnc);

        // 2) call Binance
        const accountData = await getAccountInfo(apiKey, apiSecret);

        return res.json({ ok: true, account: accountData });
    } catch (e) {
        console.error("[backend] get account error:", e);
        return res.status(500).json({ ok: false, error: "Failed to fetch account" });
    }
});

async function main() {
    await redis.connect();
    console.log("[backend] redis connected");
    app.listen(PORT, () => console.log(`[backend] listening http://localhost:${PORT}`));
}

main().catch((e) => {
    console.error("[backend] fatal:", e);
    process.exit(1);
});
