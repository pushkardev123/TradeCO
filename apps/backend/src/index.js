import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";
import { randomUUID } from "crypto";
import {
    createLogger,
    createRequestContext,
    durationMs,
    safeError,
    setTraceHeaders,
} from "@tradeco/observability";
import {
    CANCEL_IN_FLIGHT_STATUSES,
    OPEN_ORDER_STATUSES,
    formatOrderCommandDto,
    formatOrderEventDto,
    formatPositionDto,
} from "@tradeco/api-contracts";

import { verifyAccessToken } from "./jwt.js";
import { requireAuth } from "./middleware.js";
import { getAccountInfo } from "./binance.js";
import { config, isCorsOriginAllowed, logStartupConfig } from "./config.js";
import {
    getAuthenticatedUserContext,
    getSessionMeta,
    loginUser,
    logoutRefreshSession,
    refreshAuthSession,
    registerUser,
} from "./authService.js";
import { clearRefreshCookie, getRefreshTokenFromRequest, setRefreshCookie } from "./cookies.js";
import { getDecryptedExchangeCredential } from "./credentials.js";
import { validateOrderDraftAgainstBinanceFilters } from "./binanceExchangeFilters.js";
import {
    appendOrderCommandStreamEntry,
    appendOrderSubmitStreamEntry,
    createOrderCancelAllDraftFromRequest,
    createOrderCancelDraftFromRequest,
    createOrderSubmitDraftFromRequest,
    getRequestIdFromHeaders,
    isSameOrderIntent,
    shouldRetryStreamAppend,
} from "./orderStreamProducer.js";
import { addDecimalStrings, negateDecimalString } from "./tradingDecimal.js";

const PORT = config.port;
const REDIS_URL = config.redisUrl;
const COMMANDS_CHANNEL = config.commandsChannel;
const ORDER_COMMAND_STREAM = config.orderCommandStream;
const logger = createLogger({ service: "backend" });

const prisma = new PrismaClient();

const app = express();
app.use((req, res, next) => {
    const context = createRequestContext(req.headers);
    req.requestId = context.requestId;
    req.traceId = context.traceId;
    setTraceHeaders(res, context);

    const startedAt = Date.now();
    res.on("finish", () => {
        logger.info("http.request", {
            requestId: req.requestId,
            traceId: req.traceId,
            method: req.method,
            path: req.path || req.url,
            statusCode: res.statusCode,
            durationMs: durationMs(startedAt),
            userId: req.user?.id,
        });
    });

    next();
});
app.use(cors({
    origin(origin, callback) {
        if (isCorsOriginAllowed(origin)) {
            return callback(null, true);
        }
        return callback(new Error("CORS origin not allowed"));
    },
    credentials: true,
}));
app.use(express.json());

const redis = createClient({ url: REDIS_URL });
redis.on("error", (e) => logger.error("redis.error", { error: safeError(e) }));

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
    const supplied = [req.params, req.query, req.body, req.body?.meta]
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

function requestTraceId(req) {
    return req.traceId || req.requestId || getRequestIdFromHeaders(req.headers);
}

function orderLogContext(req, fields = {}) {
    return {
        requestId: req.requestId,
        traceId: req.traceId,
        userId: req.user?.id,
        ...fields,
    };
}

app.get("/health", (req, res) => res.json({
    ok: true,
    service: "backend",
    requestId: req.requestId,
    redis: {
        ready: Boolean(redis.isReady),
        open: Boolean(redis.isOpen),
    },
    uptimeSec: Math.round(process.uptime()),
}));

function isOpenOrderStatus(status) {
    return OPEN_ORDER_STATUSES.includes(String(status || "").toUpperCase());
}

function normalizeSymbolParam(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function latestEventsByOrderId(events) {
    const latestByOrderId = new Map();
    for (const ev of events) {
        if (!latestByOrderId.has(ev.orderId)) {
            latestByOrderId.set(ev.orderId, ev);
        }
    }
    return latestByOrderId;
}

async function createOrderLifecycleEvent({ order, status, timestamp = new Date() }) {
    return prisma.orderEvent.create({
        data: {
            orderId: order.orderId,
            userId: order.userId,
            status,
            price: order.avgFillPrice ?? order.price ?? null,
            quantity: order.executedQty ?? order.quantity ?? null,
            timestamp,
        },
    });
}

function sendAuthError(res, err, fallback = "Server error") {
    if (err?.code === "P2002") {
        return res.status(409).json({ ok: false, error: "Email already registered" });
    }

    if (err?.statusCode) {
        return res.status(err.statusCode).json({ ok: false, error: err.message });
    }

    logger.error("auth.error", { error: safeError(err), fallback });
    return res.status(500).json({ ok: false, error: fallback });
}

function getBearerSessionId(req) {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");
    if (type !== "Bearer" || !token) return null;

    try {
        return verifyAccessToken(token).sid;
    } catch {
        return null;
    }
}

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

        const items = rows.map(formatPositionDto);

        const nextCursor = rows.length === limit ? (rows[rows.length - 1]?.id || null) : null;
        return res.json({ ok: true, items, nextCursor, totalEntries, totalPages });
    } catch (e) {
        const msg = String(e?.message || "");
        if (msg.includes("Record to fetch does not exist") || msg.includes("not found")) {
            const totalEntries = await prisma.position.count({ where: { userId: req.user.id } });
            const totalPages = Math.max(1, Math.ceil(totalEntries / 10));
            return res.json({ ok: true, items: [], nextCursor: null, totalEntries, totalPages });
        }
        logger.error("positions.list.error", orderLogContext(req, { error: safeError(e) }));
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
            return formatOrderCommandDto(c, latest);
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
        logger.error("orders.list.error", orderLogContext(req, { error: safeError(e) }));
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

app.get("/orders/open", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const symbol = normalizeSymbolParam(req.query?.symbol);
        const commands = await prisma.orderCommand.findMany({
            where: {
                userId: req.user.id,
                status: { in: OPEN_ORDER_STATUSES },
                ...(symbol ? { symbol } : {}),
            },
            orderBy: { createdAt: "desc" },
        });

        if (commands.length === 0) {
            return res.json({ ok: true, items: [], count: 0, symbol: symbol || null });
        }

        const orderIds = commands.map((command) => command.orderId);
        const events = await prisma.orderEvent.findMany({
            where: {
                userId: req.user.id,
                orderId: { in: orderIds },
            },
            orderBy: { timestamp: "desc" },
        });
        const latestByOrderId = latestEventsByOrderId(events);

        const items = commands.map((command) => formatOrderCommandDto(command, latestByOrderId.get(command.orderId)));
        return res.json({ ok: true, items, count: items.length, symbol: symbol || null });
    } catch (e) {
        logger.error("orders.open.list.error", orderLogContext(req, { error: safeError(e) }));
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

app.get("/orders/:orderId", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const orderId = String(req.params.orderId || "").trim();
        if (!orderId) {
            return res.status(400).json({ ok: false, error: "orderId is required" });
        }

        const command = await prisma.orderCommand.findUnique({ where: { orderId } });
        if (!command || command.userId !== req.user.id) {
            return res.status(404).json({ ok: false, error: "Order not found" });
        }

        const events = await prisma.orderEvent.findMany({
            where: {
                userId: req.user.id,
                orderId,
            },
            orderBy: { timestamp: "desc" },
        });

        return res.json({
            ok: true,
            order: formatOrderCommandDto(command, events[0] || null),
            events: events.map(formatOrderEventDto),
        });
    } catch (e) {
        logger.error("orders.detail.error", orderLogContext(req, { orderId: req.params.orderId, error: safeError(e) }));
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

app.delete("/orders/open", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const draft = createOrderCancelAllDraftFromRequest({
            body: req.body || {},
            query: req.query || {},
            userId: req.user.id,
            commandId: randomUUID(),
            requestId: requestTraceId(req),
        });

        const openOrders = await prisma.orderCommand.findMany({
            where: {
                userId: req.user.id,
                symbol: draft.symbol,
                status: { in: OPEN_ORDER_STATUSES },
            },
            orderBy: { createdAt: "desc" },
        });

        const requestedAt = new Date();
        for (const order of openOrders) {
            await prisma.orderCommand.update({
                where: { orderId: order.orderId },
                data: {
                    status: "CANCEL_REQUESTED",
                    errorCode: null,
                    errorMsg: null,
                },
            });
            await createOrderLifecycleEvent({ order, status: "CANCEL_REQUESTED", timestamp: requestedAt });
        }

        try {
            const streamId = await appendOrderCommandStreamEntry({
                redis,
                streamName: ORDER_COMMAND_STREAM,
                streamEntry: draft.streamEntry,
            });
            logger.info("order.cancel_all.stream_appended", orderLogContext(req, {
                commandId: draft.commandId,
                symbol: draft.symbol,
                affectedCount: openOrders.length,
                streamName: ORDER_COMMAND_STREAM,
                streamId,
            }));
        } catch (e) {
            logger.error("order.cancel_all.stream_append_failed", orderLogContext(req, {
                commandId: draft.commandId,
                symbol: draft.symbol,
                error: safeError(e),
            }));
            for (const order of openOrders) {
                await prisma.orderCommand.update({
                    where: { orderId: order.orderId },
                    data: {
                        status: "CANCEL_APPEND_FAILED",
                        errorMsg: "Redis stream append failed",
                    },
                }).catch((updateError) => {
                    logger.error("order.cancel_all.failure_status_update_error", orderLogContext(req, { orderId: order.orderId, error: safeError(updateError) }));
                });
                await createOrderLifecycleEvent({ order, status: "CANCEL_APPEND_FAILED" }).catch((eventError) => {
                    logger.error("order.cancel_all.failure_event_create_error", orderLogContext(req, { orderId: order.orderId, error: safeError(eventError) }));
                });
            }

            return res.status(503).json({
                ok: false,
                error: "Cancel-all command persisted but stream append failed",
            });
        }

        return res.status(202).json({
            ok: true,
            commandId: draft.commandId,
            symbol: draft.symbol,
            status: "CANCEL_REQUESTED",
            affectedCount: openOrders.length,
            affectedOrderIds: openOrders.map((order) => order.orderId),
        });
    } catch (e) {
        if (e?.statusCode) {
            return res.status(e.statusCode).json({ ok: false, error: e.message });
        }
        logger.error("order.cancel_all.error", orderLogContext(req, { error: safeError(e) }));
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

app.delete("/orders/:orderId", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const orderId = String(req.params.orderId || "").trim();
        if (!orderId) {
            return res.status(400).json({ ok: false, error: "orderId is required" });
        }

        const existing = await prisma.orderCommand.findUnique({ where: { orderId } });
        if (!existing || existing.userId !== req.user.id) {
            return res.status(404).json({ ok: false, error: "Order not found" });
        }

        if (CANCEL_IN_FLIGHT_STATUSES.includes(String(existing.status || "").toUpperCase())) {
            return res.status(202).json({
                ok: true,
                orderId,
                status: existing.status,
                idempotent: true,
            });
        }

        if (!isOpenOrderStatus(existing.status)) {
            return res.status(409).json({
                ok: false,
                error: `Order cannot be canceled from status ${existing.status}`,
            });
        }

        const draft = createOrderCancelDraftFromRequest({
            body: req.body || {},
            userId: req.user.id,
            orderId,
            symbol: existing.symbol,
            commandId: randomUUID(),
            requestId: requestTraceId(req),
        });

        const requestedAt = new Date();
        await prisma.orderCommand.update({
            where: { orderId },
            data: {
                status: "CANCEL_REQUESTED",
                errorCode: null,
                errorMsg: null,
            },
        });
        await createOrderLifecycleEvent({ order: existing, status: "CANCEL_REQUESTED", timestamp: requestedAt });

        try {
            const streamId = await appendOrderCommandStreamEntry({
                redis,
                streamName: ORDER_COMMAND_STREAM,
                streamEntry: draft.streamEntry,
            });
            logger.info("order.cancel.stream_appended", orderLogContext(req, {
                commandId: draft.commandId,
                orderId,
                symbol: draft.symbol,
                streamName: ORDER_COMMAND_STREAM,
                streamId,
            }));
        } catch (e) {
            logger.error("order.cancel.stream_append_failed", orderLogContext(req, {
                commandId: draft.commandId,
                orderId,
                symbol: draft.symbol,
                error: safeError(e),
            }));
            await prisma.orderCommand.update({
                where: { orderId },
                data: {
                    status: "CANCEL_APPEND_FAILED",
                    errorMsg: "Redis stream append failed",
                },
            }).catch((updateError) => {
                logger.error("order.cancel.failure_status_update_error", orderLogContext(req, { orderId, error: safeError(updateError) }));
            });
            await createOrderLifecycleEvent({ order: existing, status: "CANCEL_APPEND_FAILED" }).catch((eventError) => {
                logger.error("order.cancel.failure_event_create_error", orderLogContext(req, { orderId, error: safeError(eventError) }));
            });

            return res.status(503).json({
                ok: false,
                error: "Cancel command persisted but stream append failed",
            });
        }

        return res.status(202).json({
            ok: true,
            commandId: draft.commandId,
            orderId,
            status: "CANCEL_REQUESTED",
        });
    } catch (e) {
        if (e?.statusCode) {
            return res.status(e.statusCode).json({ ok: false, error: e.message });
        }
        logger.error("order.cancel.error", orderLogContext(req, { orderId: req.params.orderId, error: safeError(e) }));
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});


app.post("/orders", requireAuth, async (req, res) => {
    try {
        if (rejectClientUserId(req, res)) return;

        const body = req.body || {};
        const orderId = String(body.orderId || body.id || randomUUID());
        const orderDraft = createOrderSubmitDraftFromRequest({
            body,
            userId: req.user.id,
            orderId,
            requestId: requestTraceId(req),
        });
        const filterValidation = await validateOrderDraftAgainstBinanceFilters(orderDraft);
        if (!filterValidation.ok) {
            logger.warn("order.submit.rejected_by_filters", orderLogContext(req, {
                orderId,
                symbol: orderDraft.symbol,
                side: orderDraft.side,
                orderType: orderDraft.orderType,
                errorCount: filterValidation.errors.length,
            }));
            return res.status(400).json({
                ok: false,
                error: "Order violates Binance filters",
                errors: filterValidation.errors,
            });
        }
        const command = {
            type: "ORDER_CREATED",
            orderId,
            userId: req.user.id,
            symbol: orderDraft.symbol,
            side: orderDraft.side,
            quantity: orderDraft.quantity,
            quoteOrderQty: orderDraft.quoteOrderQty,
            orderType: orderDraft.orderType,
            price: orderDraft.price,
            stopPrice: orderDraft.stopPrice,
            timeInForce: orderDraft.timeInForce,
            ts: Date.parse(orderDraft.createdAt) || Date.now(),
        };

        let persistedCommand;
        let appendToStream = true;

        try {
            persistedCommand = await prisma.orderCommand.create({
                data: {
                    userId: req.user.id,
                    orderId,
                    symbol: orderDraft.symbol,
                    side: orderDraft.side,
                    type: orderDraft.orderType,
                    quantity: orderDraft.quantity === undefined ? null : orderDraft.quantity,
                    quoteOrderQty: orderDraft.quoteOrderQty === undefined ? null : orderDraft.quoteOrderQty,
                    price: orderDraft.price === undefined ? null : orderDraft.price,
                    stopPrice: orderDraft.stopPrice === undefined ? null : orderDraft.stopPrice,
                    timeInForce: orderDraft.timeInForce || null,
                    status: "RECEIVED",
                },
            });
        } catch (e) {
            if (e?.code !== "P2002") throw e;

            persistedCommand = await prisma.orderCommand.findUnique({ where: { orderId } });

            if (!isSameOrderIntent(persistedCommand, orderDraft)) {
                return res.status(409).json({ ok: false, error: "orderId already exists" });
            }

            appendToStream = shouldRetryStreamAppend(persistedCommand);

            if (!appendToStream) {
                return res.json({
                    ok: true,
                    orderId,
                    status: persistedCommand.status === "RECEIVED" ? "PENDING" : persistedCommand.status,
                    idempotent: true,
                });
            }
        }

        try {
            if (appendToStream) {
                const streamId = await appendOrderSubmitStreamEntry({
                    redis,
                    streamName: ORDER_COMMAND_STREAM,
                    streamEntry: orderDraft.streamEntry,
                });
                logger.info("order.submit.stream_appended", orderLogContext(req, {
                    orderId,
                    symbol: orderDraft.symbol,
                    side: orderDraft.side,
                    orderType: orderDraft.orderType,
                    streamName: ORDER_COMMAND_STREAM,
                    streamId,
                }));
            }
        } catch (e) {
            logger.error("order.submit.stream_append_failed", orderLogContext(req, {
                orderId,
                symbol: orderDraft.symbol,
                side: orderDraft.side,
                orderType: orderDraft.orderType,
                error: safeError(e),
            }));
            try {
                await prisma.orderCommand.update({
                    where: { orderId },
                    data: {
                        status: "STREAM_APPEND_FAILED",
                        errorMsg: "Redis stream append failed",
                    },
                });
            } catch (updateError) {
                logger.error("order.submit.failure_status_update_error", orderLogContext(req, { orderId, error: safeError(updateError) }));
            }

            return res.status(503).json({
                ok: false,
                error: "Order command persisted but stream append failed",
            });
        }

        if (persistedCommand?.status === "STREAM_APPEND_FAILED") {
            try {
                await prisma.orderCommand.update({
                    where: { orderId },
                    data: {
                        status: "RECEIVED",
                        errorMsg: null,
                    },
                });
            } catch (updateError) {
                logger.error("order.submit.retry_status_update_error", orderLogContext(req, { orderId, error: safeError(updateError) }));
            }
        }

        await redis.publish(COMMANDS_CHANNEL, JSON.stringify(command));
        logger.info("order.submit.legacy_pubsub_published", orderLogContext(req, {
            orderId,
            symbol: orderDraft.symbol,
            channel: COMMANDS_CHANNEL,
        }));

        return res.json({ ok: true, orderId, status: "PENDING" });
    } catch (e) {
        if (e?.statusCode) {
            return res.status(e.statusCode).json({ ok: false, error: e.message });
        }
        if (e?.code === "P2002") {
            return res.status(409).json({ ok: false, error: "orderId already exists" });
        }
        logger.error("order.submit.error", orderLogContext(req, { error: safeError(e) }));
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

// -------- AUTH --------

app.post("/auth/register", async (req, res) => {
    try {
        const { email, password, binanceApiKey, binanceSecretKey } = req.body || {};
        const auth = await registerUser({
            prisma,
            email,
            password,
            binanceApiKey,
            binanceSecretKey,
            meta: getSessionMeta(req),
        });

        setRefreshCookie(res, auth.refreshToken);

        const { refreshToken: _refreshToken, ...body } = auth;
        return res.status(201).json({ ok: true, ...body });
    } catch (e) {
        return sendAuthError(res, e);
    }
});

app.post("/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const auth = await loginUser({
            prisma,
            email,
            password,
            meta: getSessionMeta(req),
        });

        setRefreshCookie(res, auth.refreshToken);

        const { refreshToken: _refreshToken, ...body } = auth;
        return res.json({ ok: true, ...body });
    } catch (e) {
        return sendAuthError(res, e);
    }
});

app.post("/auth/refresh", async (req, res) => {
    try {
        const auth = await refreshAuthSession({
            prisma,
            refreshToken: getRefreshTokenFromRequest(req),
            meta: getSessionMeta(req),
        });

        setRefreshCookie(res, auth.refreshToken);

        const { refreshToken: _refreshToken, ...body } = auth;
        return res.json({ ok: true, ...body });
    } catch (e) {
        clearRefreshCookie(res);
        return sendAuthError(res, e);
    }
});

app.post("/auth/logout", async (req, res) => {
    try {
        await logoutRefreshSession({
            prisma,
            refreshToken: getRefreshTokenFromRequest(req),
            sessionId: getBearerSessionId(req),
        });
        clearRefreshCookie(res);
        return res.json({ ok: true });
    } catch (e) {
        clearRefreshCookie(res);
        return sendAuthError(res, e);
    }
});

app.get("/auth/me", requireAuth, async (req, res) => {
    try {
        const context = await getAuthenticatedUserContext({
            prisma,
            userId: req.user.id,
            sessionId: req.user.sessionId,
        });
        return res.json({ ok: true, ...context });
    } catch (e) {
        return sendAuthError(res, e);
    }
});

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

            const quantity = cmd.side === "BUY" ? ev.quantity : negateDecimalString(ev.quantity);
            qtyBySymbol.set(cmd.symbol, addDecimalStrings(qtyBySymbol.get(cmd.symbol) || "0", quantity));
        }

        const positions = Array.from(qtyBySymbol.entries()).map(([symbol, quantity]) => ({
            symbol,
            quantity,
        }));

        return res.json({ ok: true, positions });
    } catch (e) {
        logger.error("trading.positions.error", orderLogContext(req, { error: safeError(e) }));
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

        const { apiKey, apiSecret } = await getDecryptedExchangeCredential(prisma, req.user.id);
        const accountData = await getAccountInfo(apiKey, apiSecret);

        return res.json({ ok: true, account: accountData });
    } catch (e) {
        if (e?.statusCode) {
            return res.status(e.statusCode).json({ ok: false, error: e.message });
        }
        logger.error("trading.account.error", orderLogContext(req, { error: safeError(e) }));
        return res.status(500).json({ ok: false, error: "Failed to fetch account" });
    }
});

async function main() {
    logStartupConfig();
    await redis.connect();
    logger.info("redis.connected", { redisReady: Boolean(redis.isReady) });
    app.listen(PORT, () => logger.info("http.listening", { port: PORT }));
}

main().catch((e) => {
    logger.error("service.fatal", { error: safeError(e) });
    process.exit(1);
});
