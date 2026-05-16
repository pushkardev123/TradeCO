"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { z } from "zod";
import {
    createChart,
    CrosshairMode,
    CandlestickSeries,
} from "lightweight-charts";
import { ADVANCED_ORDER_TYPES, BASIC_ORDER_TYPES, DEFAULT_REALTIME_CHANNELS, TIME_IN_FORCE as TIME_IN_FORCE_OPTIONS } from "@tradeco/api-contracts";
import { TRADECO_WEB_CLASSES } from "@tradeco/brand-tokens";

import { MdDarkMode, MdOutlineLightMode } from "react-icons/md";
import { CgProfile } from "react-icons/cg";

import { authFetch, bootstrapSession, clearAuth, ensureAccessToken } from "../lib/auth";

const PRICE_CHANNEL = DEFAULT_REALTIME_CHANNELS.prices;
const ORDER_STATUS_CHANNEL = DEFAULT_REALTIME_CHANNELS.orders;
const ACCOUNT_BALANCES_CHANNEL = DEFAULT_REALTIME_CHANNELS.balances;
const CHARTS_CHANNEL = DEFAULT_REALTIME_CHANNELS.charts;
const MARKET_DETAIL_CHANNEL = DEFAULT_REALTIME_CHANNELS.marketDetails || "events:market:details";
const ADVANCED_ORDERS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_ADVANCED_ORDERS !== "false";
const ORDER_TYPE_TABS = ADVANCED_ORDERS_ENABLED
    ? Object.freeze([...BASIC_ORDER_TYPES, ...ADVANCED_ORDER_TYPES])
    : BASIC_ORDER_TYPES;
const ORDER_TYPE_LABELS = Object.freeze({
    MARKET: "Market",
    LIMIT: "Limit",
    STOP_LOSS: "Stop Market",
    STOP_LOSS_LIMIT: "Stop Limit",
    TAKE_PROFIT: "Take Profit",
    TAKE_PROFIT_LIMIT: "TP Limit",
    LIMIT_MAKER: "Maker",
});
const LIMIT_PRICE_ORDER_TYPES = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT", "LIMIT_MAKER"]);
const STOP_PRICE_ORDER_TYPES = new Set(["STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT"]);
const TIME_IN_FORCE_ORDER_TYPES = new Set(["LIMIT", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"]);
const TC = TRADECO_WEB_CLASSES;
const MOBILE_TERMINAL_SECTIONS = Object.freeze([
    ["#order-ticket", "Trade"],
    ["#account-balances", "Assets"],
    ["#price-chart", "Chart"],
    ["#market-depth", "Book"],
    ["#terminal-activity", "Activity"],
]);
const CHART_VISIBLE_BARS = 120;

export default function TradePage() {
    const router = useRouter();
    const [isProfileOpen, setIsProfileOpen] = useState(false);
    const [status, setStatus] = useState("CONNECTING");
    const [replayStatus, setReplayStatus] = useState("idle");
    const [lastReplayAt, setLastReplayAt] = useState(null);
    const [reconnectCount, setReconnectCount] = useState(0);
    const [connectionAttempt, setConnectionAttempt] = useState(0);
    const [apiMsg, setApiMsg] = useState("");
    const [isPlacingOrder, setIsPlacingOrder] = useState(false);
    const [pendingOrderId, setPendingOrderId] = useState(null);
    const [toast, setToast] = useState({ open: false, title: "", message: "", status: "" });
    const [authReady, setAuthReady] = useState(false);
    const [authUser, setAuthUser] = useState(null);

    // orderId -> latest order status event
    const [ordersById, setOrdersById] = useState({});

    const ORDERS_PAGE_SIZE = 10;

    const [ordersPage, setOrdersPage] = useState([]);     // current page rows from backend
    const [ordersCursor, setOrdersCursor] = useState(null); // current cursor (orderId)
    const [ordersNextCursor, setOrdersNextCursor] = useState(null);
    const [ordersPrevStack, setOrdersPrevStack] = useState([]); // stack of previous cursors

    const [ordersTotalEntries, setOrdersTotalEntries] = useState(0);
    const [ordersTotalPages, setOrdersTotalPages] = useState(1);

    const ordersCurrentPage = ordersPrevStack.length + 1;
    const ordersIsFirstPage = ordersCurrentPage <= 1;
    const ordersIsLastPage = ordersCurrentPage >= ordersTotalPages;

    const [ordersLoading, setOrdersLoading] = useState(false);
    const [ordersError, setOrdersError] = useState("");

    // positions (paginated)
    const POSITIONS_PAGE_SIZE = 10;

    const [positionsPage, setPositionsPage] = useState([]); // current page rows from backend
    const [positionsCursor, setPositionsCursor] = useState(null); // cursor (Position.id)
    const [positionsNextCursor, setPositionsNextCursor] = useState(null);
    const [positionsPrevStack, setPositionsPrevStack] = useState([]);

    const [positionsTotalEntries, setPositionsTotalEntries] = useState(0);
    const [positionsTotalPages, setPositionsTotalPages] = useState(1);

    const positionsCurrentPage = positionsPrevStack.length + 1;
    const positionsIsFirstPage = positionsCurrentPage <= 1;
    const positionsIsLastPage = positionsCurrentPage >= positionsTotalPages;

    const [positionsLoading, setPositionsLoading] = useState(false);
    const [positionsError, setPositionsError] = useState("");

    // balances
    const [balances, setBalances] = useState([]); // [{ asset, free, locked }]
    const [balancesLoading, setBalancesLoading] = useState(false);
    const [balancesError, setBalancesError] = useState("");
    const [balancesUpdatedAt, setBalancesUpdatedAt] = useState(null);

    const [orderBook, setOrderBook] = useState({ symbol: "BTCUSDT", bids: [], asks: [], ts: null, status: "idle" });
    const [tradeTape, setTradeTape] = useState([]);
    const [marketDetailError, setMarketDetailError] = useState("");

    // marketBoard: { BTCUSDT: { price, ts }, ETHUSDT: { ... } }
    const [marketBoard, setMarketBoard] = useState({});
    const [filter, setFilter] = useState("");

    const [lastEvent, setLastEvent] = useState(null);
    const [lastUpdateTs, setLastUpdateTs] = useState(null);
    const [pinned, setPinned] = useState(() => new Set());

    // UI
    const [theme, setTheme] = useState(() => {
        if (typeof window === "undefined") return "light";
        try {
            const t = localStorage.getItem("theme");
            if (t === "dark" || t === "light") return t;
        } catch { }
        return "light";
    }); // 'light' | 'dark'
    const [activeTab, setActiveTab] = useState("trades"); // positions | orders | trades
    const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
    const [chartInterval, setChartInterval] = useState("1m"); // 1m | 5m | 1d | 1w
    const [chartStatus, setChartStatus] = useState("idle"); // idle | loading | waiting | ready | empty | error
    const [chartError, setChartError] = useState("");
    const [chartMeta, setChartMeta] = useState({ candleCount: 0, lastCandleTime: null, source: "" });

    const chartContainerRef = useRef(null);
    const chartApiRef = useRef(null);
    const candleSeriesRef = useRef(null);
    const pendingChartSnapshotRef = useRef(null);
    const chartReadyRef = useRef(false);
    const selectedSymbolRef = useRef(selectedSymbol);
    const chartIntervalRef = useRef(chartInterval);
    const ordersCursorRef = useRef(ordersCursor);
    const positionsCursorRef = useRef(positionsCursor);
    const websocketOpenedRef = useRef(false);
    const replaySnapshotsRef = useRef(null);

    useEffect(() => {
        selectedSymbolRef.current = selectedSymbol;
    }, [selectedSymbol]);

    useEffect(() => {
        chartIntervalRef.current = chartInterval;
    }, [chartInterval]);

    useEffect(() => {
        ordersCursorRef.current = ordersCursor;
        positionsCursorRef.current = positionsCursor;
    }, [ordersCursor, positionsCursor]);

    const [side, setSide] = useState("BUY");
    const [orderType, setOrderType] = useState("MARKET");
    const [qty, setQty] = useState("0.01");
    const [quoteOrderQty, setQuoteOrderQty] = useState("25");
    const [orderSizingMode, setOrderSizingMode] = useState("BASE");
    const [limitPrice, setLimitPrice] = useState("");
    const [stopPrice, setStopPrice] = useState("");
    const [timeInForce, setTimeInForce] = useState("GTC");
    const [formErrors, setFormErrors] = useState({}); // { qty?: string, limitPrice?: string, stopPrice?: string, notional?: string, base?: string }

    // Exchange symbol filters (LOT_SIZE etc)
    const [symbolInfo, setSymbolInfo] = useState(null);
    const [symbolInfoStatus, setSymbolInfoStatus] = useState("idle"); // idle | loading | ready | error
    const [symbolInfoError, setSymbolInfoError] = useState("");

    const UI_FLUSH_MS = Number(process.env.NEXT_PUBLIC_MARKET_FLUSH_MS || 1500);
    const MAX_SYMBOLS = Number(process.env.NEXT_PUBLIC_MAX_SYMBOLS || 1000);

    // Cache of latest prices by symbol
    const latestBoardRef = useRef({});
    // Stable insertion order for the table
    const symbolOrderRef = useRef([]);
    const latestTsRef = useRef(null);

    const eventBaseUrl = (process.env.NEXT_PUBLIC_EVENT_SERVICE_URL || "http://localhost:8081").replace(/\/$/, "");
    const wsBaseUrl = (
        process.env.NEXT_PUBLIC_WS_URL ||
        eventBaseUrl.replace(/^https?:\/\//, (m) => (m === "https://" ? "wss://" : "ws://"))
    ).replace(/\/$/, "");
    const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080").replace(/\/$/, "");
    const pricesWsUrl = wsBaseUrl.endsWith("/prices") ? wsBaseUrl : `${wsBaseUrl}/prices`;

    useEffect(() => {
        if (orderType !== "MARKET" && orderSizingMode === "QUOTE") {
            setOrderSizingMode("BASE");
        }
    }, [orderType, orderSizingMode]);

    useEffect(() => {
        let cancelled = false;

        bootstrapSession()
            .then((context) => {
                if (cancelled) return;
                setAuthUser(context?.user || null);
                setAuthReady(true);
            })
            .catch(() => {
                clearAuth();
                if (!cancelled) router.replace("/login");
            });

        return () => {
            cancelled = true;
        };
    }, [router]);

    useEffect(() => {
        if (!authReady) return;
        fetchBalances();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authReady]);

    async function replayRealtimeSnapshots() {
        if (!authReady) return;

        setReplayStatus("syncing");
        const jobs = [
            fetchBalances(),
            fetchOrdersPage(ordersCursorRef.current),
            fetchPositionsPage(positionsCursorRef.current),
        ];

        await Promise.allSettled(jobs);
        setLastReplayAt(Date.now());
        setReplayStatus("ready");
    }

    replaySnapshotsRef.current = replayRealtimeSnapshots;

    const [wsMsgCount, setWsMsgCount] = useState(0);

    useEffect(() => {
        if (!authReady) return;

        let ws;
        let retryTimer;
        let cancelled = false;
        let attempt = 0;

        const connect = async () => {
            if (cancelled) return;

            let token;
            try {
                token = await ensureAccessToken();
            } catch {
                setStatus("AUTH_ERROR");
                clearAuth();
                router.replace("/login");
                return;
            }

            const tokenParam = token ? `token=${encodeURIComponent(token)}` : "";
            const separator = pricesWsUrl.includes("?") ? "&" : "?";
            const url = tokenParam ? `${pricesWsUrl}${separator}${tokenParam}` : pricesWsUrl;
            try {
                ws = new WebSocket(url);
            } catch {
                setStatus("ERROR");
                scheduleReconnect();
                return;
            }

            ws.onopen = () => {
                const wasReconnect = websocketOpenedRef.current;
                websocketOpenedRef.current = true;
                attempt = 0;
                setConnectionAttempt(0);
                setStatus("OPEN");
                if (wasReconnect) setReconnectCount((count) => count + 1);
                replaySnapshotsRef.current?.(wasReconnect ? "reconnect" : "connect");
            };

            ws.onclose = () => {
                setStatus("RECONNECTING");
                scheduleReconnect();
            };

            ws.onerror = () => {
                setStatus("ERROR");
                // onerror is usually followed by close, but be safe
            };

            ws.onmessage = (e) => {
                setWsMsgCount((c) => c + 1);

                try {
                    const outer = JSON.parse(e.data);
                    setLastEvent(outer);

                    // We expect: { type: 'REDIS_EVENT', channel, message, ts }
                    if (outer?.type !== "REDIS_EVENT") return;

                    const channel = outer.channel;
                    let inner;
                    try {
                        inner = JSON.parse(outer.message);

                        // Some channels publish JSON-stringified JSON (double encoding)
                        if (typeof inner === "string") {
                            try {
                                inner = JSON.parse(inner);
                            } catch {
                                return; // not usable
                            }
                        }
                    } catch {
                        // If producers ever send non-JSON, ignore
                        return;
                    }

                    // Price channel
                    if (channel === PRICE_CHANNEL) {
                        if (inner?.type === "MARKET_BOARD" && Array.isArray(inner.data)) {
                            const ts = inner.ts || outer.ts || Date.now();

                            const board = latestBoardRef.current || {};
                            const order = symbolOrderRef.current || [];
                            const seen = new Set(order);

                            for (const t of inner.data) {
                                const symbol = t?.symbol ? String(t.symbol).toUpperCase() : "";
                                if (!symbol) continue;
                                const price = Number(t.price);
                                if (!Number.isFinite(price)) continue;

                                if (!seen.has(symbol)) {
                                    if (order.length >= MAX_SYMBOLS) continue;
                                    order.push(symbol);
                                    seen.add(symbol);
                                }

                                board[symbol] = { price, ts };
                            }

                            latestBoardRef.current = board;
                            symbolOrderRef.current = order;
                            latestTsRef.current = ts;
                            return;
                        }

                        if (inner?.type === "PRICE_UPDATE" && inner.symbol) {
                            const price = Number(inner.price);
                            if (!Number.isFinite(price)) return;

                            const sym = String(inner.symbol).toUpperCase();
                            const ts = inner.ts || outer.ts || Date.now();

                            const board = latestBoardRef.current || {};
                            const order = symbolOrderRef.current || [];

                            if (!board[sym]) {
                                if (order.length >= MAX_SYMBOLS) return;
                                order.push(sym);
                                symbolOrderRef.current = order;
                            }

                            board[sym] = { price, ts };
                            latestBoardRef.current = board;
                            latestTsRef.current = ts;
                            return;
                        }
                    }

                    // Order status channel
                    if (channel === ORDER_STATUS_CHANNEL) {
                        const ev = inner;
                        // execution-service should publish the client order id as `orderId`.
                        // If it publishes it under another key, accept those too.
                        const orderId = ev?.orderId || ev?.clientOrderId || ev?.origClientOrderId || ev?.id;
                        if (!orderId) return;

                        setOrdersById((prev) => {
                            const next = { ...prev };
                            next[orderId] = { ...next[orderId], ...ev, orderId, updatedAt: Date.now() };

                            const ids = Object.keys(next);
                            if (ids.length > 1000) {
                                ids.sort((a, b) => (next[a]?.updatedAt || 0) - (next[b]?.updatedAt || 0));
                                const toDrop = ids.slice(0, ids.length - 1000);
                                for (const id of toDrop) delete next[id];
                            }
                            return next;
                        });

                        // console.log("Received order status update for pending order:", ev);
                        if (pendingOrderId && String(orderId) === String(pendingOrderId)) {
                            // if (true) {
                            const st = String(ev?.status || "").toUpperCase();

                            // Treat PARTIALLY_FILLED as "done enough" for UI: user should be able to close toast
                            // and place another order if they want.
                            const isFinalish = [
                                "FILLED",
                                "REJECTED",
                                "CANCELED",
                                "CANCELLED",
                                "EXPIRED",
                                "PARTIALLY_FILLED",
                                "NEW",
                                "PENDING",
                                "PENDING_CANCEL",
                            ].includes(st);

                            setToast({
                                open: true,
                                title: isFinalish ? "Order update" : "Order submitted",
                                status: st || "PENDING",
                                message: `${ev?.side || ""} ${ev?.symbol || ""} • qty ${ev?.quantity ?? "—"}`.trim(),
                            });

                            if (isFinalish) {
                                setIsPlacingOrder(false);
                                setPendingOrderId(null);
                            }
                        }
                    }

                    // Account balance channel (execution-service -> Redis -> event-service -> WS)
                    // Expected inner payload shapes:
                    // - { type: 'ACCOUNT_BALANCES', balances: [{ asset, free, locked }] }
                    if (channel === ACCOUNT_BALANCES_CHANNEL) {
                        const items = Array.isArray(inner?.balances)
                            ? inner.balances
                            : Array.isArray(inner?.items)
                                ? inner.items
                                : Array.isArray(inner?.data)
                                    ? inner.data
                                    : [];

                        if (items.length) {
                            setBalances(
                                items
                                    .map((b) => ({
                                        asset: String(b.asset || "").toUpperCase(),
                                        free: String(b.free ?? "0"),
                                        locked: String(b.locked ?? "0"),
                                    }))
                                    .filter((b) => b.asset)
                            );
                            setBalancesUpdatedAt(Date.now());
                            setBalancesError("");
                        }
                        return;
                    }

                    if (channel === MARKET_DETAIL_CHANNEL) {
                        const sym = String(inner?.symbol || "").toUpperCase();
                        if (!sym || sym !== String(selectedSymbolRef.current).toUpperCase()) return;

                        if ((inner?.type === "ORDER_BOOK_SNAPSHOT" || inner?.type === "ORDER_BOOK_UPDATE") && Array.isArray(inner?.bids) && Array.isArray(inner?.asks)) {
                            setOrderBook({
                                symbol: sym,
                                bids: inner.bids.slice(0, 20),
                                asks: inner.asks.slice(0, 20),
                                ts: inner.ts || outer.ts || Date.now(),
                                status: "ready",
                            });
                            setMarketDetailError("");
                            return;
                        }

                        if (inner?.type === "TRADE_TAPE_UPDATE" && Array.isArray(inner?.trades)) {
                            setTradeTape((prev) => {
                                const incoming = inner.trades
                                    .map((trade) => ({
                                        id: String(trade.id ?? `${trade.ts}-${trade.price}-${trade.quantity}`),
                                        price: String(trade.price ?? ""),
                                        quantity: String(trade.quantity ?? ""),
                                        side: String(trade.side || "").toUpperCase(),
                                        ts: Number(trade.ts || inner.ts || outer.ts || Date.now()),
                                    }))
                                    .filter((trade) => trade.price && trade.quantity);

                                const seen = new Set();
                                return [...incoming, ...prev]
                                    .filter((trade) => {
                                        const key = `${sym}:${trade.id}`;
                                        if (seen.has(key)) return false;
                                        seen.add(key);
                                        return true;
                                    })
                                    .slice(0, 50);
                            });
                            setMarketDetailError("");
                            return;
                        }
                    }

                } catch {
                    // ignore parse errors
                }
            };
        };

        const scheduleReconnect = () => {
            if (cancelled) return;
            if (retryTimer) return;
            attempt += 1;
            setConnectionAttempt(attempt);
            setStatus("RECONNECTING");
            const delay = Math.min(8000, 500 * attempt);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                connect();
            }, delay);
        };

        connect();

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            try {
                ws?.close();
            } catch { }
        };
    }, [authReady, pricesWsUrl, MAX_SYMBOLS, pendingOrderId, router]);

    useEffect(() => {
        if (!authReady) return;

        const replayOnResume = () => {
            if (document.visibilityState && document.visibilityState !== "visible") return;
            replaySnapshotsRef.current?.("resume");
        };

        document.addEventListener("visibilitychange", replayOnResume);
        window.addEventListener("focus", replayOnResume);
        return () => {
            document.removeEventListener("visibilitychange", replayOnResume);
            window.removeEventListener("focus", replayOnResume);
        };
    }, [authReady]);

    useEffect(() => {
        try {
            const raw = localStorage.getItem("pinnedSymbols");
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) setPinned(new Set(arr.map((s) => String(s).toUpperCase())));
        } catch { }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem("pinnedSymbols", JSON.stringify(Array.from(pinned)));
        } catch { }
    }, [pinned]);


    useEffect(() => {
        try {
            localStorage.setItem("theme", theme);
        } catch { }

        document.documentElement.style.colorScheme = theme;
        if (theme === "dark") document.documentElement.classList.add("dark");
        else document.documentElement.classList.remove("dark");
    }, [theme]);

    useEffect(() => {
        // Flush latestBoardRef to state every UI_FLUSH_MS
        const interval = setInterval(() => {
            setMarketBoard({ ...latestBoardRef.current });
            setLastUpdateTs(latestTsRef.current);
        }, UI_FLUSH_MS);
        return () => clearInterval(interval);
    }, [UI_FLUSH_MS]);

    useEffect(() => {
        if (!authReady) return;
        if (activeTab === "orders") {
            fetchOrdersPage(ordersCursor);
            return;
        }
        if (activeTab === "positions") {
            fetchPositionsPage(positionsCursor);
            return;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authReady, activeTab, ordersCursor, positionsCursor]);

    function handleAuthFailure(error) {
        if (error?.status !== 401) return false;
        clearAuth();
        router.replace("/login");
        return true;
    }

    function buildResponseError(json, res, fallback) {
        const err = new Error(json?.error || fallback || `Request failed (${res.status})`);
        err.status = res.status;
        return err;
    }

    async function fetchPositionsPage(cursor = null) {
        setPositionsLoading(true);
        setPositionsError("");

        try {
            const qs = new URLSearchParams();
            qs.set("limit", String(POSITIONS_PAGE_SIZE));
            if (cursor) qs.set("cursor", String(cursor));

            const res = await authFetch(`${apiBaseUrl}/positions?${qs.toString()}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
                cache: "no-store",
            });

            const json = await res.json().catch(() => ({}));
            if (!res.ok || json?.ok === false) {
                throw buildResponseError(json, res, `Failed to fetch positions (${res.status})`);
            }

            const items = Array.isArray(json?.items)
                ? json.items
                : Array.isArray(json?.data)
                    ? json.data
                    : [];

            setPositionsPage(items);

            const nc =
                json?.nextCursor ||
                (items.length ? items[items.length - 1]?.id || null : null);

            setPositionsNextCursor(nc || null);

            const te = Number(json?.totalEntries);
            const tp = Number(json?.totalPages);
            if (Number.isFinite(te)) setPositionsTotalEntries(te);
            if (Number.isFinite(tp) && tp > 0) setPositionsTotalPages(tp);
        } catch (e) {
            if (handleAuthFailure(e)) return;
            setPositionsError(e?.message || "Failed to fetch positions");
            setPositionsPage([]);
            setPositionsNextCursor(null);
            setPositionsTotalEntries(0);
            setPositionsTotalPages(1);
        } finally {
            setPositionsLoading(false);
        }
    }

    function togglePin(sym) {
        const s = String(sym).toUpperCase();
        setPinned((prev) => {
            const next = new Set(prev);
            if (next.has(s)) next.delete(s);
            else next.add(s);
            return next;
        });
    }

    async function copyOrderId(id) {
        try {
            await navigator.clipboard.writeText(String(id));
            setApiMsg("Copied order id");
            setTimeout(() => setApiMsg(""), 1200);
        } catch {
            setApiMsg("Could not copy");
            setTimeout(() => setApiMsg(""), 1200);
        }
    }

    function toggleTheme() {
        setTheme((t) => (t === "dark" ? "light" : "dark"));
    }

    function formatPrice(p) {
        if (!Number.isFinite(Number(p))) return "—";
        return Number(p).toFixed(6).replace(/\.?0+$/, "");
    }

    function asNumber(x) {
        const n = Number(x);
        return Number.isFinite(n) ? n : null;
    }

    function decimalsFromStep(step) {
        const s = String(step);
        const i = s.indexOf(".");
        return i === -1 ? 0 : s.length - i - 1;
    }

    function roundToStep(value, step) {
        const v = asNumber(value);
        const st = asNumber(step);
        if (v === null || st === null || st <= 0) return null;

        const d = decimalsFromStep(step);
        const scale = Math.pow(10, d);

        // Convert to integers in "step decimals" space to avoid float remainder issues.
        const stepInt = Math.round(st * scale);
        if (!Number.isFinite(stepInt) || stepInt <= 0) return null;

        // Snap DOWN to nearest step.
        const vInt = Math.floor(v * scale + 1e-9); // tiny epsilon to counter float noise
        const snappedInt = Math.floor(vInt / stepInt) * stepInt;
        const out = snappedInt / scale;

        return Number(out.toFixed(d));
    }

    function trimZeros(n) {
        return String(n).replace(/\.?0+$/, "");
    }

    function normalizeChartTime(value) {
        const time = Number(value);
        if (!Number.isFinite(time) || time <= 0) return null;
        // Binance REST candles already arrive in seconds after backend normalization.
        // WebSocket kline start times arrive in milliseconds.
        return Math.floor(time > 10_000_000_000 ? time / 1000 : time);
    }

    function normalizeCandle(candle) {
        const time = normalizeChartTime(candle?.time ?? candle?.startTime ?? candle?.t);
        const open = Number(candle?.open ?? candle?.o);
        const high = Number(candle?.high ?? candle?.h);
        const low = Number(candle?.low ?? candle?.l);
        const close = Number(candle?.close ?? candle?.c);

        if (
            time === null ||
            !Number.isFinite(open) ||
            !Number.isFinite(high) ||
            !Number.isFinite(low) ||
            !Number.isFinite(close)
        ) {
            return null;
        }

        return { time, open, high, low, close };
    }

    function normalizeCandleSet(candles) {
        if (!Array.isArray(candles)) return [];

        const byTime = new Map();
        for (const candle of candles) {
            const bar = normalizeCandle(candle);
            if (!bar) continue;
            byTime.set(bar.time, bar);
        }

        return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    }

    function fitChartToRecentBars(bars) {
        const chart = chartApiRef.current;
        if (!chart) return;

        const timeScale = chart.timeScale();
        if (!Array.isArray(bars) || bars.length === 0) {
            timeScale.fitContent();
            return;
        }

        if (bars.length <= CHART_VISIBLE_BARS) {
            timeScale.fitContent();
            return;
        }

        timeScale.setVisibleLogicalRange({
            from: Math.max(0, bars.length - CHART_VISIBLE_BARS),
            to: bars.length + 4,
        });
    }

    function applyChartSnapshot(bars, meta = {}) {
        const series = candleSeriesRef.current;
        if (!series) {
            pendingChartSnapshotRef.current = { bars, meta };
            return;
        }

        if (!Array.isArray(bars) || bars.length === 0) {
            series.setData([]);
            chartReadyRef.current = false;
            setChartStatus("empty");
            setChartError("No candles returned for this market and interval.");
            setChartMeta({ candleCount: 0, lastCandleTime: null, source: meta.source || "" });
            return;
        }

        chartReadyRef.current = true;
        setChartStatus("ready");
        setChartError("");
        setChartMeta({
            candleCount: bars.length,
            lastCandleTime: bars[bars.length - 1]?.time || null,
            source: meta.source || "stream",
        });

        try {
            series.setData(bars);
            fitChartToRecentBars(bars);
            pendingChartSnapshotRef.current = null;
        } catch (error) {
            chartReadyRef.current = false;
            setChartStatus("error");
            setChartError(error?.message || "Unable to render candle data.");
        }
    }

    function applyChartUpdate(bar) {
        const series = candleSeriesRef.current;
        if (!series || !bar) return;

        chartReadyRef.current = true;
        setChartStatus("ready");
        setChartError("");
        setChartMeta((prev) => ({
            candleCount: Math.max(prev.candleCount || 0, 1),
            lastCandleTime: bar.time || prev.lastCandleTime || null,
            source: "WS",
        }));

        try {
            series.update(bar);
        } catch (error) {
            setChartStatus("error");
            setChartError(error?.message || "Unable to apply live candle update.");
        }
    }

    function formatByStep(value, step) {
        const v = asNumber(value);
        const st = asNumber(step);
        if (v === null) return "—";
        if (st === null || st <= 0) return trimZeros(v);

        const d = Math.min(decimalsFromStep(step), 8); // cap for UI
        return trimZeros(Number(v).toFixed(d));
    }

    function validateNotional({ qtyNum, info, orderType, priceForNotional, notionalOverride }) {
        if (!info) return { ok: true };

        const minN = asNumber(info.minNotional);
        const maxN = asNumber(info.maxNotional);

        const applyMinToMarket = Boolean(info.applyMinToMarket);
        const applyMaxToMarket = Boolean(info.applyMaxToMarket);

        const shouldApplyMin = orderType !== "MARKET" || applyMinToMarket;
        const shouldApplyMax = orderType !== "MARKET" || applyMaxToMarket;

        if (!shouldApplyMin && !shouldApplyMax) return { ok: true };

        let notional = asNumber(notionalOverride);
        if (notional === null) {
            const p = asNumber(priceForNotional);
            if (p === null || p <= 0) return { ok: true }; // can't validate w/out a price
            notional = p * qtyNum;
        }

        if (shouldApplyMin && minN !== null && notional < minN) {
            return { ok: false, reason: `Notional too small: ${trimZeros(notional)} < min ${trimZeros(minN)} USDT` };
        }
        if (shouldApplyMax && maxN !== null && notional > maxN) {
            return { ok: false, reason: `Notional too large: ${trimZeros(notional)} > max ${trimZeros(maxN)} USDT` };
        }
        return { ok: true };
    }

    function validateQty(q, info) {
        const qn = asNumber(q);
        if (qn === null || qn <= 0) return { ok: false, reason: "Enter a valid quantity" };
        if (!info) return { ok: true };

        const minQty = asNumber(info.minQty);
        if (minQty !== null && qn < minQty) {
            return { ok: false, reason: `Min qty is ${info.minQty}` };
        }

        const step = asNumber(info.stepSize);
        if (step === null || step <= 0) return { ok: true };

        const d = decimalsFromStep(info.stepSize);
        const scale = Math.pow(10, d);

        const stepInt = Math.round(step * scale);
        if (!Number.isFinite(stepInt) || stepInt <= 0) return { ok: true };

        // Integer-space divisibility check (prevents float false negatives)
        const qtyInt = Math.round(qn * scale);
        if (qtyInt % stepInt !== 0) {
            return { ok: false, reason: `Qty must be a multiple of ${info.stepSize}` };
        }

        return { ok: true };
    }

    // Zod error mapping helper
    function zodErrorMap(err) {
        // Convert ZodError into a simple { field: message } map
        const out = {};
        for (const issue of err.issues || []) {
            const key = (issue.path && issue.path.length ? issue.path[0] : "base") || "base";
            if (!out[key]) out[key] = issue.message;
        }
        return out;
    }

    // Build a Zod schema for order form validation
    function buildOrderSchema({ info, orderType, currentPrice, orderSizingMode }) {
        // Accept strings from inputs; transform to numbers where needed
        return z
            .object({
                qty: z
                    .string()
                    .trim()
                    .optional(),
                quoteOrderQty: z.string().trim().optional(),
                limitPrice: z.string().trim().optional(),
                stopPrice: z.string().trim().optional(),
                timeInForce: z.string().trim().optional(),
            })
            .superRefine((val, ctx) => {
                const usesQuoteSizing = orderType === "MARKET" && orderSizingMode === "QUOTE";
                const quoteNum = Number(val.quoteOrderQty);
                let qtyNum = Number(val.qty);

                if (usesQuoteSizing) {
                    if (!Number.isFinite(quoteNum) || quoteNum <= 0) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["quoteOrderQty"], message: "Enter a valid quote amount" });
                        return;
                    }
                } else {
                    const qcheck = validateQty(val.qty, info);
                    if (!qcheck.ok) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["qty"], message: qcheck.reason });
                        return;
                    }
                    qtyNum = Number(val.qty);
                }

                // Order-type specific price validation
                let priceForNotional = currentPrice;

                if (LIMIT_PRICE_ORDER_TYPES.has(orderType)) {
                    const p = Number(val.limitPrice);
                    if (!Number.isFinite(p) || p <= 0) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["limitPrice"], message: "Enter a valid limit price" });
                        return;
                    }
                    priceForNotional = p;
                }

                if (STOP_PRICE_ORDER_TYPES.has(orderType)) {
                    const sp = Number(val.stopPrice);
                    if (!Number.isFinite(sp) || sp <= 0) {
                        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["stopPrice"], message: "Enter a valid stop price" });
                        return;
                    }
                    if (!LIMIT_PRICE_ORDER_TYPES.has(orderType)) {
                        priceForNotional = sp;
                    }
                }

                if (TIME_IN_FORCE_ORDER_TYPES.has(orderType) && !TIME_IN_FORCE_OPTIONS.includes(String(val.timeInForce || "").toUpperCase())) {
                    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timeInForce"], message: "Choose a time in force" });
                    return;
                }

                // Notional validation (minNotional/maxNotional)
                const ncheck = validateNotional({
                    qtyNum,
                    info,
                    orderType,
                    priceForNotional,
                    notionalOverride: usesQuoteSizing ? quoteNum : undefined,
                });
                if (!ncheck.ok) {
                    // Show this as a general form error (not tied to one field)
                    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["notional"], message: ncheck.reason });
                    return;
                }
            });
    }

    async function fetchOrdersPage(cursor = null) {
        setOrdersLoading(true);
        setOrdersError("");

        try {
            const qs = new URLSearchParams();
            qs.set("limit", String(ORDERS_PAGE_SIZE));
            if (cursor) qs.set("cursor", String(cursor)); // orderId cursor

            const res = await authFetch(`${apiBaseUrl}/orders?${qs.toString()}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
                cache: "no-store",
            });

            const json = await res.json().catch(() => ({}));
            if (!res.ok || json?.ok === false) {
                throw buildResponseError(json, res, `Failed to fetch orders (${res.status})`);
            }

            // Expect: { ok: true, items: [...], nextCursor: "..." }
            const items = Array.isArray(json?.items)
                ? json.items
                : Array.isArray(json?.data)
                    ? json.data
                    : [];

            setOrdersPage(items);

            const nc =
                json?.nextCursor ||
                (items.length ? items[items.length - 1]?.orderId || null : null);

            setOrdersNextCursor(nc || null);

            const te = Number(json?.totalEntries);
            const tp = Number(json?.totalPages);
            if (Number.isFinite(te)) setOrdersTotalEntries(te);
            if (Number.isFinite(tp) && tp > 0) setOrdersTotalPages(tp);
        } catch (e) {
            if (handleAuthFailure(e)) return;
            setOrdersError(e?.message || "Failed to fetch orders");
            setOrdersPage([]);
            setOrdersNextCursor(null);
            setOrdersTotalEntries(0);
            setOrdersTotalPages(1);
        } finally {
            setOrdersLoading(false);
        }
    }

    async function fetchBalances() {
        setBalancesLoading(true);
        setBalancesError("");

        try {
            const qs = new URLSearchParams();
            const pinnedAssets = Array.from(pinned);
            if (pinnedAssets.length) qs.set("pinned", pinnedAssets.join(","));
            const query = qs.toString();

            const res = await authFetch(`${eventBaseUrl}/account-info${query ? `?${query}` : ""}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
                cache: "no-store",
            });

            const json = await res.json().catch(() => ({}));
            if (!res.ok || json?.ok === false) {
                throw buildResponseError(json, res, `Failed to fetch balances (${res.status})`);
            }

            const balanceGroups = [
                json?.balances,
                json?.data?.balances,
                json?.data?.pinned,
                json?.data?.nonZero,
                json?.account?.balances,
            ].filter(Array.isArray);

            const byAsset = new Map();
            for (const group of balanceGroups) {
                for (const b of group) {
                    const asset = String(b.asset || "").toUpperCase();
                    if (!asset) continue;
                    byAsset.set(asset, {
                        asset,
                        free: String(b.free ?? "0"),
                        locked: String(b.locked ?? "0"),
                    });
                }
            }

            setBalances(Array.from(byAsset.values()));
            setBalancesUpdatedAt(Date.now());
        } catch (e) {
            if (handleAuthFailure(e)) return;
            setBalances([]);
            setBalancesError(e?.message || "Failed to fetch balances");
        } finally {
            setBalancesLoading(false);
        }
    }

    const requestChartStream = useCallback(async function requestChartStream(symbol, interval, action = "subscribe") {
        const normalizedSymbol = String(symbol || "").toUpperCase();
        const normalizedInterval = String(interval || "1m");

        const res = await fetch(`${eventBaseUrl}/charts/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbol: normalizedSymbol,
                interval: normalizedInterval,
            }),
        });

        if (!res.ok) {
            throw new Error(`Chart stream ${action} failed (${res.status})`);
        }
    }, [eventBaseUrl]);

    const fetchChartSnapshot = useCallback(async function fetchChartSnapshot(symbol, interval) {
        const qs = new URLSearchParams({
            symbol: String(symbol || "").toUpperCase(),
            interval: String(interval || "1m"),
            limit: "500",
        });

        const res = await fetch(`${eventBaseUrl}/charts/snapshot?${qs.toString()}`, {
            method: "GET",
            cache: "no-store",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false) {
            throw new Error(json?.error || `Chart snapshot failed (${res.status})`);
        }

        const candles = Array.isArray(json?.candles)
            ? json.candles
            : Array.isArray(json?.data?.candles)
                ? json.data.candles
                : [];

        applyChartSnapshot(normalizeCandleSet(candles), { source: json?.source || "REST" });
    // Chart helpers are function declarations that read refs/setters; the endpoint URL is the only external input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eventBaseUrl]);

    const requestMarketDetails = useCallback(async function requestMarketDetails(symbol, action = "subscribe") {
        const res = await fetch(`${eventBaseUrl}/market/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbol: String(symbol || "").toUpperCase(),
            }),
        });

        if (!res.ok) {
            throw new Error(`Market stream request failed (${res.status})`);
        }
    }, [eventBaseUrl]);

    const isDark = theme === "dark";


    // 1) Create the chart ONCE (do not recreate on theme toggle)
    useEffect(() => {
        if (!authReady) return;

        const el = chartContainerRef.current;
        if (!el) return;

        // Ensure the container is clean before mounting a new chart
        try {
            el.innerHTML = "";
        } catch { }

        // cleanup previous chart (defensive)
        try {
            chartApiRef.current?.remove?.();
        } catch { }
        chartApiRef.current = null;
        candleSeriesRef.current = null;

        const chart = createChart(el, {
            autoSize: true,
            crosshair: { mode: CrosshairMode.Normal },
            timeScale: { timeVisible: true, secondsVisible: false },
            layout: {
                background: { color: "#ffffff" },
                textColor: "#334155",
            },
            grid: {
                vertLines: { color: "#e2e8f0" },
                horzLines: { color: "#e2e8f0" },
            },
        });

        const series = chart.addSeries(CandlestickSeries, {});
        chartApiRef.current = chart;
        candleSeriesRef.current = series;
        if (pendingChartSnapshotRef.current) {
            applyChartSnapshot(
                pendingChartSnapshotRef.current.bars,
                pendingChartSnapshotRef.current.meta
            );
        }

        return () => {
            try {
                chart.remove();
            } catch { }
            chartApiRef.current = null;
            candleSeriesRef.current = null;
        };
    // The chart instance is mounted after auth reveals the chart container; theme/data updates are handled separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authReady]);

    // 2) Update chart colors when theme changes (do NOT wipe data)
    useEffect(() => {
        const chart = chartApiRef.current;
        if (!chart) return;

        chart.applyOptions({
            layout: {
                background: { color: isDark ? "#020617" : "#ffffff" },
                textColor: isDark ? "#cbd5e1" : "#334155",
            },
            grid: {
                vertLines: { color: isDark ? "#0f172a" : "#e2e8f0" },
                horzLines: { color: isDark ? "#0f172a" : "#e2e8f0" },
            },
        });

        // Optional: candle style tweaks for dark mode (keeps data intact)
        const series = candleSeriesRef.current;
        if (series?.applyOptions) {
            series.applyOptions({
                priceFormat: { type: "price", precision: 6, minMove: 0.000001 },
            });
        }
    }, [isDark]);

    useEffect(() => {
        let cancelled = false;

        async function fetchSymbolInfo() {
            setSymbolInfoStatus("loading");
            setSymbolInfoError("");

            try {
                const res = await fetch(
                    `${eventBaseUrl}/symbol-info?symbol=${selectedSymbol}`
                );
                const json = await res.json();

                if (!res.ok) throw new Error(json.error || "Failed to load symbol info");

                if (!cancelled) {
                    setSymbolInfo(json.data);
                    setSymbolInfoStatus("ready");

                    // snap qty to step size
                    const snapped = roundToStep(qty, json.data.stepSize);
                    if (snapped !== null) setQty(String(snapped));
                }
            } catch (err) {
                if (!cancelled) {
                    setSymbolInfo(null);
                    setSymbolInfoStatus("error");
                    setSymbolInfoError(err.message);
                }
            }
        }

        fetchSymbolInfo();
        return () => (cancelled = true);
        // Symbol metadata should refresh only when the selected market changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedSymbol]);

    useEffect(() => {
        if (!authReady) return;

        const symbol = String(selectedSymbol || "").toUpperCase();
        const interval = String(chartInterval || "1m");
        let cancelled = false;
        let ws;
        let waitingTimer;
        let retryTimer;
        let reconnectTimer;

        setChartStatus("loading");
        setChartError("");
        setChartMeta({ candleCount: 0, lastCandleTime: null, source: "" });
        chartReadyRef.current = false;
        pendingChartSnapshotRef.current = null;
        try {
            candleSeriesRef.current?.setData([]);
        } catch { }

        fetchChartSnapshot(symbol, interval).catch((error) => {
            if (cancelled) return;
            setChartStatus((current) => current === "loading" ? "waiting" : current);
            setChartError(error?.message || "Chart snapshot unavailable");
        });

        async function connectChartSocket() {
            let token;
            try {
                token = await ensureAccessToken();
            } catch {
                if (!cancelled) {
                    setChartStatus("error");
                    setChartError("Chart stream authentication failed.");
                }
                return;
            }

            if (cancelled) return;

            const tokenParam = `token=${encodeURIComponent(token)}`;
            const separator = pricesWsUrl.includes("?") ? "&" : "?";
            ws = new WebSocket(`${pricesWsUrl}${separator}${tokenParam}`);

            ws.onopen = () => {
                requestChartStream(symbol, interval, "subscribe").catch((error) => {
                    if (cancelled) return;
                    setChartStatus("error");
                    setChartError(error?.message || "Chart stream unavailable");
                });

                waitingTimer = setTimeout(() => {
                    if (cancelled) return;
                    setChartStatus((current) => current === "loading" ? "waiting" : current);
                }, 3500);

                retryTimer = setInterval(() => {
                    if (cancelled) return;
                    if (chartReadyRef.current) return;
                    requestChartStream(symbol, interval, "subscribe").catch(() => {});
                    fetchChartSnapshot(symbol, interval).catch(() => {});
                }, 8000);
            };

            ws.onmessage = (event) => {
                try {
                    const outer = JSON.parse(event.data);
                    if (outer?.type !== "REDIS_EVENT" || outer.channel !== CHARTS_CHANNEL) return;

                    let inner = JSON.parse(outer.message);
                    if (typeof inner === "string") inner = JSON.parse(inner);

                    const sym = String(inner?.symbol || "").toUpperCase();
                    const itv = String(inner?.interval || "");
                    if (!sym || sym !== symbol) return;
                    if (itv && itv !== interval) return;

                    if (inner?.type === "KLINE_SNAPSHOT" && Array.isArray(inner?.candles)) {
                        applyChartSnapshot(normalizeCandleSet(inner.candles), { source: inner?.source || "REST" });
                        return;
                    }

                    if (inner?.type === "KLINE_UPDATE") {
                        const bar = normalizeCandle(inner?.kline || inner?.k || inner?.data);
                        if (bar) applyChartUpdate(bar);
                    }
                } catch (error) {
                    setChartStatus("error");
                    setChartError(error?.message || "Unable to process chart stream data.");
                }
            };

            ws.onerror = () => {
                if (cancelled) return;
                setChartStatus("error");
                setChartError("Chart socket connection failed.");
            };

            ws.onclose = () => {
                if (cancelled) return;
                reconnectTimer = setTimeout(connectChartSocket, 2000);
            };
        }

        connectChartSocket();

        return () => {
            cancelled = true;
            if (waitingTimer) clearTimeout(waitingTimer);
            if (retryTimer) clearInterval(retryTimer);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            try {
                ws?.close();
            } catch { }
            requestChartStream(symbol, interval, "unsubscribe").catch(() => {});
        };
    // Chart helpers are function declarations and use refs/setters; this socket is scoped by auth, URL, symbol, and interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authReady, selectedSymbol, chartInterval, pricesWsUrl, requestChartStream, fetchChartSnapshot]);

    useEffect(() => {
        if (!authReady) return;
        const symbol = String(selectedSymbol || "").toUpperCase();
        setOrderBook({ symbol, bids: [], asks: [], ts: null, status: "loading" });
        setTradeTape([]);
        setMarketDetailError("");
        requestMarketDetails(symbol, "subscribe")
            .catch(() => setMarketDetailError("Market depth stream unavailable"));

        return () => {
            requestMarketDetails(symbol, "unsubscribe").catch(() => {});
        };
    }, [authReady, selectedSymbol, requestMarketDetails]);

    async function placeOrder() {
        setApiMsg("");
        setFormErrors({});
        if (isPlacingOrder) return;
        setIsPlacingOrder(true);

        const schema = buildOrderSchema({ info: symbolInfo, orderType, currentPrice: asNumber(currentPrice), orderSizingMode });
        const parsed = schema.safeParse({
            qty,
            quoteOrderQty,
            limitPrice,
            stopPrice,
            timeInForce,
        });

        if (!parsed.success) {
            const map = zodErrorMap(parsed.error);
            setFormErrors(map);
            // Also show a short message in apiMsg for visibility
            setApiMsg(map.notional || map.qty || map.quoteOrderQty || map.limitPrice || map.stopPrice || map.timeInForce || map.base || "Fix the highlighted fields");
            setIsPlacingOrder(false);
            return;
        }

        const usesQuoteSizing = orderType === "MARKET" && orderSizingMode === "QUOTE";
        let qtyNum = usesQuoteSizing ? undefined : Number(parsed.data.qty);
        const quoteOrderQtyValue = usesQuoteSizing ? parsed.data.quoteOrderQty : undefined;
        let limitPriceNum = LIMIT_PRICE_ORDER_TYPES.has(orderType) ? Number(parsed.data.limitPrice) : undefined;
        let stopPriceNum = STOP_PRICE_ORDER_TYPES.has(orderType) ? Number(parsed.data.stopPrice) : undefined;

        // Snap inputs to exchange filters (stepSize, tickSize)
        if (symbolInfo) {
            if (qtyNum !== undefined && symbolInfo.stepSize) {
                const s = roundToStep(qtyNum, symbolInfo.stepSize);
                if (s !== null) qtyNum = s;
            }
            if (symbolInfo.tickSize) {
                if (limitPriceNum !== undefined) {
                    const s = roundToStep(limitPriceNum, symbolInfo.tickSize);
                    if (s !== null) limitPriceNum = s;
                }
                if (stopPriceNum !== undefined) {
                    const s = roundToStep(stopPriceNum, symbolInfo.tickSize);
                    if (s !== null) stopPriceNum = s;
                }
            }
        }

        setApiMsg("Placing order...");
        const clientOrderId =
            typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : `ord-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        setPendingOrderId(clientOrderId);
        setToast({
            open: true,
            title: "Placing order",
            status: "PENDING",
            message: usesQuoteSizing
                ? `${side} ${selectedSymbol} • quote ${quoteOrderQtyValue} USDT`
                : `${side} ${selectedSymbol} • qty ${qtyNum}`,
        });

        try {
            const payload = {
                orderId: clientOrderId,
                symbol: String(selectedSymbol || "").toUpperCase(),
                side: String(side || "").toUpperCase(),
                orderType: String(orderType || "MARKET").toUpperCase(),
                meta: {},
            };

            if (usesQuoteSizing) {
                payload.quoteOrderQty = quoteOrderQtyValue;
            } else {
                payload.quantity = qtyNum;
            }

            // Keep fields explicit:
            // - LIMIT/stop-limit/maker variants use `price`
            // - Stop/take-profit variants use `stopPrice`
            if (LIMIT_PRICE_ORDER_TYPES.has(orderType)) {
                payload.price = limitPriceNum;
            }
            if (STOP_PRICE_ORDER_TYPES.has(orderType)) {
                payload.stopPrice = stopPriceNum;
            }
            if (TIME_IN_FORCE_ORDER_TYPES.has(orderType)) {
                payload.timeInForce = timeInForce;
            }

            const res = await authFetch(`${apiBaseUrl}/orders`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            });

            const data = await res.json();
            console.log("Place order response:", data);
            if (!res.ok || !data.ok) {
                if (res.status === 401) {
                    setIsPlacingOrder(false);
                    clearAuth();
                    router.replace("/login");
                    return;
                }
                setIsPlacingOrder(false);
                setApiMsg(data.error || "Order failed");
                return;
            }

            setApiMsg("Order sent. Waiting for status...");
        } catch (e) {
            if (handleAuthFailure(e)) {
                setIsPlacingOrder(false);
                return;
            }
            setIsPlacingOrder(false);
            setApiMsg("Network error");
        }
    }

    const f = filter.trim().toLowerCase();

    // Keep table stable: insertion order + pinned coins on top
    const orderedSymbols = symbolOrderRef.current;

    const pinnedList = Array.from(pinned);
    const pinnedSet = pinned;

    const pinnedRows = pinnedList
        .map((sym) => [sym, marketBoard[sym]])
        .filter(([sym, v]) => v && (!f || sym.toLowerCase().includes(f)));

    const regularRows = orderedSymbols
        .filter((sym) => !pinnedSet.has(sym))
        .map((sym) => [sym, marketBoard[sym]])
        .filter(([sym, v]) => v && (!f || sym.toLowerCase().includes(f)));

    const rows = [...pinnedRows, ...regularRows];
    const shown = rows.slice(0, MAX_SYMBOLS);

    // Derived rows (pinned first)
    const totalSymbols = symbolOrderRef.current.length;

    const currentPrice = marketBoard[selectedSymbol]?.price;
    const isRealtimeOpen = status === "OPEN";
    const connectionLabel =
        replayStatus === "syncing"
            ? "Syncing"
            : isRealtimeOpen
                ? "Live"
                : status === "RECONNECTING"
                    ? `Reconnect ${connectionAttempt || 1}`
                    : status === "AUTH_ERROR"
                        ? "Auth"
                        : "Offline";
    const connectionTone = isRealtimeOpen
        ? replayStatus === "syncing"
            ? TC.tone.info
            : TC.tone.success
        : status === "AUTH_ERROR"
            ? TC.tone.danger
            : TC.tone.warning;
    const lastReplayLabel = lastReplayAt ? `Synced ${new Date(lastReplayAt).toLocaleTimeString()}` : "Pending sync";
    const themeClass = isDark ? TC.theme.dark : TC.theme.light;
    const chartStatusLabel = {
        idle: "Chart idle",
        loading: "Loading candles",
        waiting: "Waiting for candles",
        ready: "Candles live",
        empty: "No candles",
        error: "Chart error",
    }[chartStatus] || "Chart";
    const chartStatusClass =
        chartStatus === "ready"
            ? TC.tone.success
            : chartStatus === "error" || chartStatus === "empty"
                ? TC.tone.danger
                : TC.tone.warning;
    const lastCandleLabel = chartMeta.lastCandleTime
        ? new Date(chartMeta.lastCandleTime * 1000).toLocaleTimeString()
        : "—";
    const topBookSpread = calculateSpread(orderBook?.bids?.[0]?.[0], orderBook?.asks?.[0]?.[0]) || "—";
    const activeAssetsCount = balances.filter((balance) => Number(balance.free || 0) || Number(balance.locked || 0)).length;
    const trackedOrderCount = Object.keys(ordersById).length;

    const requiresLimitPrice = LIMIT_PRICE_ORDER_TYPES.has(orderType);
    const requiresStopPrice = STOP_PRICE_ORDER_TYPES.has(orderType);
    const requiresTimeInForce = TIME_IN_FORCE_ORDER_TYPES.has(orderType);
    const usesQuoteSizing = orderType === "MARKET" && orderSizingMode === "QUOTE";
    const estimatedTotal = usesQuoteSizing
        ? quoteOrderQty
        : `${formatPrice((Number(currentPrice) || 0) * (Number(qty) || 0))}`;

    if (!authReady) {
        return (
            <main className={`${TC.theme.dark} ${TC.authShell}`}>
                <div className={`text-sm ${TC.text.muted}`}>Checking session...</div>
            </main>
        );
    }

    return (
        <main className={`${themeClass} ${TC.shell} transition-colors duration-200`}>
            {/* Topbar - Glassmorphism style */}
            <div className={`sticky top-0 z-40 border-b backdrop-blur-md ${TC.topbar}`}>
                <div className="max-w-[1920px] mx-auto px-4 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 font-bold tracking-tighter text-lg">
                            <Image src="/logo.svg" alt="Logo" className="invert opacity-90" width={150} height={100} />
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {/* Live Indicator with Glow */}
                        <div
                            className={`hidden md:flex items-center gap-2 px-3 py-1.5 text-xs font-medium ${TC.statusPill} ${connectionTone}`}
                            title={`${lastReplayLabel}${reconnectCount ? ` • reconnects ${reconnectCount}` : ""}`}
                        >
                            <span className="relative flex h-2 w-2">
                                {isRealtimeOpen && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75"></span>}
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-current"></span>
                            </span>
                            {connectionLabel}
                        </div>

                        <div className={`flex items-center ${TC.segment} rounded-full`}>
                            <button
                                onClick={toggleTheme}
                                className={`px-3 py-3 text-xs font-medium rounded-full transition-all ${TC.segmentActive}`}
                            >
                                {isDark ? <MdDarkMode /> : <MdOutlineLightMode />}
                            </button>
                        </div>

                        {/* Profile Dropdown Container */}
                        <div className="relative">
                            <button
                                onClick={() => setIsProfileOpen(!isProfileOpen)}
                                className={`h-9 w-9 flex items-center justify-center transition-all duration-200 ${isProfileOpen ? TC.iconButtonActive : TC.iconButton}`}
                            >
                                <CgProfile className="text-lg" />
                            </button>

                            {/* Dropdown Menu */}
                            {isProfileOpen && (
                                <div
                                    className={`absolute right-0 mt-2 w-56 backdrop-blur-sm z-50 transform origin-top-right transition-all ${TC.dropdown}`}
                                >
                                    <div className="p-1.5 space-y-0.5">
                                        {/* Header / User Info (Optional) */}
                                        <div className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider ${TC.text.muted}`}>
                                            {authUser?.email || "My Account"}
                                        </div>

                                        {/* Edit Details */}
                                        <button
                                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${isDark ? "hover:bg-white/5 hover:text-white" : "hover:bg-neutral-100 hover:text-black"
                                                }`}
                                            onClick={() => { alert("Coming soon!"); }}

                                        >
                                            {/* Icon: FiEdit or similar */}
                                            <svg className="w-4 h-4 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                            Edit Details
                                        </button>

                                        {/* Divider */}
                                        <div className={`my-1 h-px ${isDark ? "bg-white/5" : "bg-black/5"}`}></div>

                                        {/* Logout */}
                                        <button
                                            className={`w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg hover:bg-rose-500/10 transition-colors ${TC.tone.danger}`}
                                            onClick={() => {
                                                router.push("/logout");
                                            }}
                                        >
                                            {/* Icon: FiLogOut or similar */}
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                                            Logout
                                        </button>
                                    </div>

                                    {/* Footer Section: Close */}
                                    <div className={`p-1.5 border-t ${isDark ? "border-white/5 bg-white/5" : "border-black/5 bg-neutral-50/50"}`}>
                                        <button
                                            onClick={() => setIsProfileOpen(false)}
                                            className={`w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${isDark ? "text-neutral-400 hover:text-white hover:bg-white/5" : "text-neutral-500 hover:text-black hover:bg-black/5"
                                                }`}
                                        >
                                            Close Menu
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="max-w-[1920px] mx-auto px-3 py-4 sm:px-4 lg:px-6 lg:py-5">
                <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="text-xl font-semibold tracking-tight">Portfolio & Trade</h1>
                            <span className={`rounded border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${TC.tone.info}`}>
                                Binance Spot Testnet
                            </span>
                        </div>
                        <div className={`mt-1 text-xs ${TC.text.muted}`}>
                            {selectedSymbol.replace("USDT", "")}/USDT execution workspace · {lastReplayLabel}
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:w-[620px]">
                        <TerminalMetric label="Last price" value={formatPrice(currentPrice)} tone={TC.text.primary} />
                        <TerminalMetric label="Spread" value={topBookSpread} tone={orderBook.status === "ready" ? TC.tone.success : TC.tone.warning} />
                        <TerminalMetric label="Assets" value={String(activeAssetsCount)} tone={TC.text.primary} />
                        <TerminalMetric label="Tracked orders" value={String(trackedOrderCount)} tone={trackedOrderCount ? TC.tone.info : TC.text.muted} />
                    </div>
                </div>

                <MobileTerminalNav />

                <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)_420px] 2xl:grid-cols-[380px_minmax(0,1fr)_460px]">
                    {/* Left Column: Controls */}
                    <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">

                        {/* Order Box */}
                        <OrderTicketPanel>
                            <div className="p-5">
                                {/* Buy/Sell Segmented Control */}
                                <div className={`grid grid-cols-2 gap-1 p-1 mb-6 ${TC.segment}`}>
                                    <button
                                        onClick={() => setSide("BUY")}
                                        className={`py-2 text-sm font-semibold rounded-md transition-all ${side === "BUY"
                                            ? `${TC.segmentActive} ${TC.side.buyActive}`
                                            : TC.segmentInactive}`}
                                    >
                                        BUY
                                    </button>
                                    <button
                                        onClick={() => setSide("SELL")}
                                        className={`py-2 text-sm font-semibold rounded-md transition-all ${side === "SELL"
                                            ? `${TC.segmentActive} ${TC.side.sellActive}`
                                            : TC.segmentInactive}`}
                                    >
                                        SELL
                                    </button>
                                </div>

                                {/* Order Type Tabs */}
                                <div className="flex gap-3 border-b border-neutral-200 dark:border-white/5 mb-6 pb-2 overflow-x-auto">
                                    {ORDER_TYPE_TABS.map((t) => {
                                        const isActive = orderType === t;
                                        return (
                                            <button
                                                key={t}
                                                onClick={() => {
                                                    setOrderType(t);
                                                    if (!LIMIT_PRICE_ORDER_TYPES.has(t)) setLimitPrice("");
                                                    if (!STOP_PRICE_ORDER_TYPES.has(t)) setStopPrice("");
                                                    if (!TIME_IN_FORCE_ORDER_TYPES.has(t)) setTimeInForce("GTC");
                                                }}
                                                className={`text-xs font-medium pb-2 -mb-2.5 border-b-2 transition-colors whitespace-nowrap ${isActive
                                                    ? TC.tab.active
                                                    : TC.tab.inactive}`}
                                            >
                                                {ORDER_TYPE_LABELS[t] || t}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Inputs */}
                                <div className="space-y-4">
                                    {orderType === "MARKET" && (
                                        <div>
                                            <div className="flex justify-between text-xs mb-1.5 text-neutral-500">
                                                <span>Size by</span>
                                            </div>
                                            <div className={`grid grid-cols-2 gap-1 p-1 ${TC.segment}`}>
                                                {[
                                                    ["BASE", selectedSymbol.replace("USDT", "")],
                                                    ["QUOTE", "USDT"],
                                                ].map(([mode, label]) => (
                                                    <button
                                                        key={mode}
                                                        type="button"
                                                        onClick={() => {
                                                            setOrderSizingMode(mode);
                                                            setFormErrors((prev) => ({ ...prev, qty: undefined, quoteOrderQty: undefined, notional: undefined }));
                                                        }}
                                                        className={`py-2 text-xs font-semibold rounded-md transition-all ${orderSizingMode === mode
                                                            ? TC.segmentActive
                                                            : TC.segmentInactive}`}
                                                    >
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {requiresLimitPrice && (
                                        <div>
                                            <div className="flex justify-between text-xs mb-1.5 text-neutral-500">
                                                <span>Limit price</span>
                                            </div>
                                            <div className={`flex items-center px-3 py-2.5 transition-all ${TC.input}`}>
                                                <input
                                                    className="bg-transparent text-sm w-full outline-none font-mono"
                                                    placeholder="Enter limit price"
                                                    value={limitPrice}
                                                    onChange={(e) => {
                                                        setLimitPrice(e.target.value);
                                                        setFormErrors((prev) => ({ ...prev, limitPrice: undefined, notional: undefined }));
                                                    }}
                                                />
                                                <span className="text-xs text-neutral-500 font-medium">USDT</span>
                                            </div>
                                            {formErrors.limitPrice && (
                                                <div className={`mt-1.5 text-xs font-medium ${TC.tone.danger}`}>{formErrors.limitPrice}</div>
                                            )}
                                        </div>
                                    )}

                                    {requiresStopPrice && (
                                        <div>
                                            <div className="flex justify-between text-xs mb-1.5 text-neutral-500">
                                                <span>Stop price</span>
                                            </div>
                                            <div className={`flex items-center px-3 py-2.5 transition-all ${TC.input}`}>
                                                <input
                                                    className="bg-transparent text-sm w-full outline-none font-mono"
                                                    placeholder="Enter stop trigger"
                                                    value={stopPrice}
                                                    onChange={(e) => {
                                                        setStopPrice(e.target.value);
                                                        setFormErrors((prev) => ({ ...prev, stopPrice: undefined, notional: undefined }));
                                                    }}
                                                />
                                                <span className="text-xs text-neutral-500 font-medium">USDT</span>
                                            </div>
                                            {formErrors.stopPrice && (
                                                <div className={`mt-1.5 text-xs font-medium ${TC.tone.danger}`}>{formErrors.stopPrice}</div>
                                            )}
                                        </div>
                                    )}

                                    {orderType === "MARKET" && <div className="text-xs text-neutral-500">Executes at best available Testnet price.</div>}
                                    {formErrors.notional && (
                                        <div className={`text-xs font-medium ${TC.tone.danger}`}>{formErrors.notional}</div>
                                    )}

                                    {requiresTimeInForce && (
                                        <div>
                                            <div className="text-xs mb-1.5 text-neutral-500">Time in force</div>
                                            <div className={`grid grid-cols-3 gap-1 p-1 ${TC.segment}`}>
                                                {TIME_IN_FORCE_OPTIONS.map((option) => (
                                                    <button
                                                        key={option}
                                                        type="button"
                                                        onClick={() => {
                                                            setTimeInForce(option);
                                                            setFormErrors((prev) => ({ ...prev, timeInForce: undefined }));
                                                        }}
                                                        className={`py-2 text-xs font-semibold rounded-md transition-all ${timeInForce === option
                                                            ? TC.segmentActive
                                                            : TC.segmentInactive}`}
                                                    >
                                                        {option}
                                                    </button>
                                                ))}
                                            </div>
                                            {formErrors.timeInForce && <div className={`mt-1.5 text-xs font-medium ${TC.tone.danger}`}>{formErrors.timeInForce}</div>}
                                        </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <div className="text-xs mb-1.5 text-neutral-500">{usesQuoteSizing ? "Quote amount" : "Quantity"}</div>
                                            <div className={`flex items-center px-3 py-2.5 transition-all ${TC.input}`}>
                                                <input
                                                    className="bg-transparent text-sm w-full outline-none font-mono"
                                                    value={usesQuoteSizing ? quoteOrderQty : qty}
                                                    onChange={(e) => {
                                                        if (usesQuoteSizing) {
                                                            setQuoteOrderQty(e.target.value);
                                                            setFormErrors((prev) => ({ ...prev, quoteOrderQty: undefined, notional: undefined }));
                                                        } else {
                                                            setQty(e.target.value);
                                                            setFormErrors((prev) => ({ ...prev, qty: undefined, notional: undefined }));
                                                        }
                                                    }}
                                                    placeholder="0.00"
                                                />
                                                <span className="text-xs text-neutral-500 font-medium">{usesQuoteSizing ? "USDT" : selectedSymbol.replace("USDT", "")}</span>
                                            </div>
                                            {formErrors.qty && <div className={`mt-1.5 text-xs font-medium ${TC.tone.danger}`}>{formErrors.qty}</div>}
                                            {formErrors.quoteOrderQty && <div className={`mt-1.5 text-xs font-medium ${TC.tone.danger}`}>{formErrors.quoteOrderQty}</div>}
                                        </div>
                                        <div>
                                            <div className="text-xs mb-1.5 text-neutral-500">Total</div>
                                            <div className={`flex items-center px-3 py-2.5 ${TC.readonlyInput}`}>
                                                <input
                                                    className="bg-transparent text-sm w-full outline-none font-mono cursor-default"
                                                    placeholder="0.00"
                                                    disabled
                                                    value={estimatedTotal}
                                                    readOnly
                                                />
                                                <span className="text-xs opacity-70 font-medium">USDT</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between py-2 text-xs">
                                        <span className="text-neutral-500">Last Price</span>
                                        <span className={`font-mono font-medium ${isDark ? "text-white" : "text-black"}`}>{formatPrice(currentPrice)}</span>
                                    </div>

                                    <SymbolFilterSummary
                                        orderType={orderType}
                                        status={symbolInfoStatus}
                                        symbolInfo={symbolInfo}
                                    />

                                    {symbolInfoStatus === "error" && (
                                        <div className={`text-xs bg-rose-500/10 p-2 rounded ${TC.tone.danger}`}>{symbolInfoError}</div>
                                    )}

                                    <button
                                        onClick={placeOrder}
                                        disabled={isPlacingOrder}
                                        className={`w-full rounded-lg py-3.5 text-sm font-bold text-white transition-all transform active:scale-[0.98] ${side === "BUY" ? "bg-emerald-500 hover:bg-emerald-400" : "bg-rose-500 hover:bg-rose-400"} ${isPlacingOrder ? "cursor-not-allowed opacity-80" : ""}`}
                                    >
                                        {isPlacingOrder ? "Submitting..." : (
                                            <>
                                                {side === "BUY" ? "Buy" : "Sell"} {selectedSymbol.replace("USDT", "")}
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </OrderTicketPanel>

                        {/* Account Summary */}
                        <BalancesPanel>
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-sm font-semibold tracking-tight">Assets</h3>
                                <button
                                    onClick={fetchBalances}
                                    disabled={balancesLoading}
                                    className={`p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ${balancesLoading ? "animate-spin" : ""}`}
                                    title="Refresh balances"
                                >
                                    <svg className={`w-3.5 h-3.5 ${isDark ? "text-neutral-400" : "text-neutral-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                </button>
                            </div>

                            {balancesError && <div className={`text-xs mb-3 ${TC.tone.danger}`}>{balancesError}</div>}

                            <div className="space-y-3 text-sm">
                                {(() => {
                                    const byAsset = new Map(balances.map((b) => [b.asset, b]));
                                    const usdt = byAsset.get("USDT");
                                    const usdtFree = usdt ? Number(usdt.free || 0) : 0;
                                    const pinnedBases = Array.from(pinned).map((s) => String(s).toUpperCase().replace(/USDT$/, "")).filter((s) => s && s !== "USDT");
                                    const uniqPinnedBases = Array.from(new Set(pinnedBases)).slice(0, 8);

                                    return (
                                        <>
                                            <div className="flex items-center justify-between py-1">
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${TC.side.buyBadge}`}>$</div>
                                                    <span className="font-medium">USDT</span>
                                                </div>
                                                <div className="text-right">
                                                    <div className="font-mono font-medium">{trimZeros(usdtFree.toFixed(2))}</div>
                                                </div>
                                            </div>

                                            {uniqPinnedBases.length > 0 && (
                                                <div className="border-t border-dashed border-neutral-200 dark:border-white/10 pt-3 mt-3 space-y-3">
                                                    {uniqPinnedBases.map((asset) => {
                                                        const b = byAsset.get(asset);
                                                        const free = b ? Number(b.free || 0) : 0;
                                                        const sym = `${asset}USDT`;
                                                        const mark = Number(marketBoard[sym]?.price || 0);
                                                        const est = Number.isFinite(mark) && mark > 0 ? free * mark : null;

                                                        if (free === 0) return null;

                                                        return (
                                                            <div key={asset} className="flex items-center justify-between">
                                                                <button
                                                                    onClick={() => setSelectedSymbol(sym)}
                                                                    className={`text-xs font-medium transition-colors ${TC.symbolLink}`}
                                                                >
                                                                    {asset}
                                                                </button>
                                                                <div className="text-right">
                                                                    <div className="font-mono text-xs">{trimZeros(free.toFixed(4))}</div>
                                                                    <div className="text-[10px] text-neutral-500">
                                                                        {est !== null ? `≈ $${formatPrice(est)}` : "—"}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            {balancesUpdatedAt && <div className="pt-2 text-[10px] text-neutral-500 text-right">Updated {new Date(balancesUpdatedAt).toLocaleTimeString()}</div>}
                                        </>
                                    );
                                })()}
                            </div>
                        </BalancesPanel>
                    </div>

                    {/* Center Column: Chart Workspace */}
                    <div className="space-y-4 flex flex-col h-full min-h-0 w-full min-w-0">
                        {/* Chart Section */}
                        <ChartPanel>
                            <div className="flex flex-wrap items-center justify-between p-4 border-b border-neutral-100 dark:border-white/5 gap-x-4 gap-y-4">
                                <div className="flex items-center gap-4">
                                    <h2 className="text-lg font-bold tracking-tight">{selectedSymbol.replace("USDT", "")}<span className="text-neutral-500 text-sm font-normal">/USDT</span></h2>
                                    <div className="h-4 w-[1px] bg-neutral-200 dark:bg-white/10"></div>
                                    <div className={`font-mono text-lg font-medium tracking-tight ${isDark ? "text-white" : "text-neutral-900"}`}>
                                        {formatPrice(currentPrice)}
                                    </div>
                                    <div className={`hidden rounded-full border px-2.5 py-1 text-[11px] font-medium sm:block ${chartStatusClass}`}>
                                        {chartStatusLabel}
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-3">
                                    <div className={`text-[11px] ${TC.text.muted}`}>
                                        {chartMeta.candleCount ? `${chartMeta.candleCount} bars` : "No bars"} · Last {lastCandleLabel}
                                    </div>
                                    <div className={`flex rounded-lg overflow-hidden border ${TC.segment}`}>
                                        {["1m", "5m", "1d", "1w"].map((t) => (
                                            <button
                                                key={t}
                                                onClick={() => setChartInterval(t)}
                                                className={`px-3 py-1.5 text-xs font-medium transition-colors ${t === chartInterval
                                                    ? TC.segmentActive
                                                    : TC.segmentInactive}`}
                                            >
                                                {t}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="relative h-[420px] min-h-[420px] w-full p-1 xl:h-[min(56vh,620px)]">
                                <div ref={chartContainerRef} className="w-full h-full" />
                                {chartStatus !== "ready" && (
                                    <div className="pointer-events-none absolute inset-1 flex items-center justify-center">
                                        <div className="max-w-sm rounded-lg border border-neutral-200 bg-white/90 px-4 py-3 text-center shadow-sm backdrop-blur dark:border-white/10 dark:bg-neutral-950/85">
                                            <div className={`text-xs font-semibold ${chartStatusClass}`}>{chartStatusLabel}</div>
                                            <div className={`mt-1 text-xs ${TC.text.muted}`}>
                                                {chartError ||
                                                    (chartStatus === "waiting"
                                                        ? "The request was accepted, but no kline snapshot has arrived yet."
                                                        : "Preparing the selected market and interval.")}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </ChartPanel>
                    </div>

                    {/* Right Column: Market Microstructure */}
                    <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
                        <MarketMicrostructurePanel
                            error={marketDetailError}
                            orderBook={orderBook}
                            selectedSymbol={selectedSymbol}
                            tradeTape={tradeTape}
                        />
                    </div>

                    {/* Bottom Workspace: Portfolio and market activity */}
                    <div className="xl:col-start-2 xl:col-span-2">
                        <ActivityPanel>
                            {/* Header: Flex col on mobile, row on desktop to prevent squashing */}
                            <div className="flex flex-col md:flex-row md:items-center justify-between px-4 pt-4 pb-2 border-b border-neutral-100 dark:border-white/5 gap-4">
                                {/* Tabs Container: Added overflow-x-auto to handle many tabs on small screen */}
                                <div className="flex gap-6 overflow-x-auto w-full md:w-auto pb-2 md:pb-0 scrollbar-hide">
                                    {[
                                        { id: "positions", label: "Open Positions" },
                                        { id: "orders", label: "Order History" },
                                        { id: "trades", label: "Market Board" },
                                    ].map((t) => (
                                        <button
                                            key={t.id}
                                            onClick={() => {
                                                setActiveTab(t.id);
                                                // Reset cursors logic
                                                if (t.id === "orders") { setOrdersCursor(null); setOrdersNextCursor(null); setOrdersPrevStack([]); setOrdersTotalEntries(0); setOrdersTotalPages(1); }
                                                if (t.id === "positions") { setPositionsError(""); setPositionsCursor(null); setPositionsNextCursor(null); setPositionsPrevStack([]); setPositionsTotalEntries(0); setPositionsTotalPages(1); }
                                            }}
                                            className={`text-sm font-medium pb-3 border-b-2 transition-colors whitespace-nowrap ${activeTab === t.id
                                                ? TC.tab.activeAccent
                                                : TC.tab.inactive}`}
                                        >
                                            {t.label}
                                        </button>
                                    ))}
                                </div>

                                {activeTab === "trades" && (
                                    <div className={`flex items-center px-2 py-1.5 w-full md:w-auto ${TC.input}`}>
                                        <svg className="w-3 h-3 text-neutral-500 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                        <input
                                            className="bg-transparent text-xs outline-none w-full md:w-32"
                                            value={filter}
                                            onChange={(e) => setFilter(e.target.value)}
                                            placeholder="Filter Symbol"
                                        />
                                    </div>
                                )}
                            </div>

                            <div className="flex-1 overflow-hidden relative">
                                <div className="absolute inset-0 overflow-auto custom-scrollbar">
                                    <table className="w-full text-sm text-left">
                                        <thead className={`sticky top-0 z-10 text-xs uppercase tracking-wider ${TC.tableHeader}`}>
                                            <tr>
                                                {activeTab === "positions" && ["Symbol", "Size", "Entry", "Mark", "Realized PnL", "Unrealized PnL"].map(h => <th key={h} className="px-5 py-3 font-medium whitespace-nowrap">{h}</th>)}
                                                {activeTab === "orders" && ["ID", "Symbol", "Side", "Type", "Qty", "Status"].map(h => <th key={h} className="px-5 py-3 font-medium whitespace-nowrap">{h}</th>)}
                                                {activeTab === "trades" && ["Pin", "Symbol", "Price", "Time"].map(h => <th key={h} className="px-5 py-3 font-medium whitespace-nowrap">{h}</th>)}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-neutral-100 dark:divide-white/5">
                                            {activeTab === "positions" && (
                                                <PositionsTableRows
                                                    marketBoard={marketBoard}
                                                    positionsError={positionsError}
                                                    positionsLoading={positionsLoading}
                                                    positionsPage={positionsPage}
                                                    onSelectSymbol={setSelectedSymbol}
                                                />
                                            )}
                                            {activeTab === "orders" && (
                                                <OrdersTableRows
                                                    copyOrderId={copyOrderId}
                                                    isDark={isDark}
                                                    ordersById={ordersById}
                                                    ordersLoading={ordersLoading}
                                                    ordersPage={ordersPage}
                                                    onSelectSymbol={setSelectedSymbol}
                                                />
                                            )}
                                            {activeTab === "trades" && (
                                                <MarketBoardRows
                                                    pinned={pinned}
                                                    shown={shown}
                                                    togglePin={togglePin}
                                                    onSelectSymbol={setSelectedSymbol}
                                                />
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* Footer / Pagination */}
                            {(activeTab === "positions" || activeTab === "orders") && (
                                <div
                                    className={`flex items-center justify-between p-2 border-t ${isDark ? "border-white/10" : "border-black/5"}`}>

                                    <div className="text-xs text-neutral-500">
                                        {activeTab === "positions" ? positionsTotalEntries : ordersTotalEntries} items
                                    </div>
                                    <div className="flex gap-2">
                                        <button
                                            className={`p-1.5 rounded-md disabled:opacity-30 ${TC.iconButton}`}
                                            onClick={() => activeTab === "positions" ? fetchPositionsPage(positionsCursor) : fetchOrdersPage(ordersCursor)}
                                            disabled={activeTab === "positions" ? positionsLoading : ordersLoading}
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                                        </button>
                                        <button
                                            className={`p-1.5 rounded-md disabled:opacity-30 ${TC.iconButton}`}
                                            disabled={(activeTab === "positions" ? positionsPrevStack.length === 0 : ordersPrevStack.length === 0)}
                                            onClick={() => {
                                                if (activeTab === "positions") {
                                                    setPositionsPrevStack(prev => {
                                                        const next = [...prev];
                                                        setPositionsCursor(next.pop() || null);
                                                        return next;
                                                    });
                                                } else {
                                                    setOrdersPrevStack(prev => {
                                                        const next = [...prev];
                                                        setOrdersCursor(next.pop() || null);
                                                        return next;
                                                    });
                                                }
                                            }}
                                        >
                                            <FiArrowLeft className="w-4 h-4" />
                                        </button>
                                        <span className="text-xs flex items-center px-2 text-neutral-500">
                                            Page {activeTab === "positions" ? positionsCurrentPage : ordersCurrentPage}
                                        </span>
                                        <button
                                            className={`p-1.5 rounded-md disabled:opacity-30 ${TC.iconButton}`}
                                            disabled={activeTab === "positions" ? (!positionsNextCursor || positionsIsLastPage) : (!ordersNextCursor || ordersIsLastPage)}
                                            onClick={() => {
                                                if (activeTab === "positions" && positionsNextCursor) {
                                                    setPositionsPrevStack(p => [...p, positionsCursor]);
                                                    setPositionsCursor(positionsNextCursor);
                                                } else if (activeTab === "orders" && ordersNextCursor) {
                                                    setOrdersPrevStack(p => [...p, ordersCursor]);
                                                    setOrdersCursor(ordersNextCursor);
                                                }
                                            }}
                                        >
                                            <FiArrowRight className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </ActivityPanel>
                    </div>
                </div>
            </div>

            {/* Toast Modal - Styled Premium */}
            {toast.open && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 sm:p-0">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={() => !isPlacingOrder && setToast(t => ({ ...t, open: false }))} />
                    <div className={`relative w-full max-w-sm overflow-hidden transform transition-all ${TC.panel}`}>
                        <div className={`h-1.5 w-full ${toast.status === "FILLED" ? "bg-emerald-500" : toast.status === "REJECTED" ? "bg-rose-500" : "bg-neutral-500"}`}></div>
                        <div className="p-6">
                            <h3 className="text-lg font-bold tracking-tight mb-1">{toast.title}</h3>
                            <p className={`text-sm mb-4 ${isDark ? "text-neutral-400" : "text-neutral-500"}`}>{toast.message}</p>

                            <div className="flex gap-3 mt-6">
                                <button
                                    onClick={() => { setActiveTab("orders"); setToast(t => ({ ...t, open: false })); }}
                                    className={`flex-1 py-2.5 text-sm font-medium rounded-lg ${TC.secondaryButton}`}
                                >
                                    View Order
                                </button>
                                <button
                                    onClick={() => setToast(t => ({ ...t, open: false }))}
                                    className={`flex-1 py-2.5 text-sm font-bold rounded-lg ${TC.primaryButton}`}
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}

function MobileTerminalNav() {
    return (
        <nav className="mb-4 flex gap-2 overflow-x-auto pb-1 xl:hidden" aria-label="Terminal sections">
            {MOBILE_TERMINAL_SECTIONS.map(([href, label]) => (
                <a
                    key={href}
                    href={href}
                    className={`shrink-0 px-3 py-2 text-xs font-semibold rounded-lg ${TC.secondaryButton}`}
                >
                    {label}
                </a>
            ))}
        </nav>
    );
}

function TerminalMetric({ label, value, tone }) {
    return (
        <div className="rounded-lg border border-neutral-200 bg-white/70 px-3 py-2 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
            <div className={`text-[10px] font-medium uppercase tracking-wide ${TC.text.muted}`}>{label}</div>
            <div className={`mt-1 truncate font-mono text-sm font-semibold ${tone || TC.text.primary}`}>{value}</div>
        </div>
    );
}

function SymbolFilterSummary({ orderType, status, symbolInfo }) {
    if (status === "loading") {
        return (
            <div className={`rounded-lg border border-neutral-200 p-3 text-xs dark:border-white/10 ${TC.text.muted}`}>
                Loading Binance filters...
            </div>
        );
    }

    if (!symbolInfo) return null;

    const fields = [
        ["Min qty", symbolInfo.minQty],
        ["Step", symbolInfo.stepSize],
        ["Min notional", symbolInfo.minNotional ? `${trimNumericZeros(symbolInfo.minNotional)} USDT` : "—"],
    ];

    return (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 p-3 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="mb-2 flex items-center justify-between">
                <span className={`text-[11px] font-semibold uppercase tracking-wide ${TC.text.muted}`}>Exchange filters</span>
                <span className={`text-[11px] font-medium ${TC.tone.success}`}>{orderType}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
                {fields.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                        <div className={`text-[10px] ${TC.text.muted}`}>{label}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px]">{value || "—"}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function formatPriceValue(value) {
    if (!Number.isFinite(Number(value))) return "—";
    return Number(value).toFixed(6).replace(/\.?0+$/, "");
}

function trimNumericZeros(value) {
    return String(value).replace(/\.?0+$/, "");
}

function TerminalPanel({ id, className = "", children }) {
    return (
        <section id={id} className={`${TC.panel} scroll-mt-20 ${className}`}>
            {children}
        </section>
    );
}

function OrderTicketPanel({ children }) {
    return (
        <TerminalPanel id="order-ticket" className="overflow-hidden">
            {children}
        </TerminalPanel>
    );
}

function BalancesPanel({ children }) {
    return (
        <TerminalPanel id="account-balances" className="p-5">
            {children}
        </TerminalPanel>
    );
}

function ChartPanel({ children }) {
    return (
        <TerminalPanel id="price-chart" className="flex flex-col overflow-hidden">
            {children}
        </TerminalPanel>
    );
}

function ActivityPanel({ children }) {
    return (
        <TerminalPanel id="terminal-activity" className="flex min-h-[420px] flex-1 flex-col overflow-hidden">
            {children}
        </TerminalPanel>
    );
}

function MarketMicrostructurePanel({ error, orderBook, selectedSymbol, tradeTape }) {
    const spread = calculateSpread(orderBook?.bids?.[0]?.[0], orderBook?.asks?.[0]?.[0]);

    return (
        <TerminalPanel id="market-depth" className="flex min-h-[420px] flex-col overflow-hidden xl:h-[min(56vh,620px)]">
            <div className="flex flex-col gap-3 border-b border-neutral-100 p-4 dark:border-white/5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h3 className="text-sm font-semibold tracking-tight">Order Book & Tape</h3>
                    <div className={`mt-1 text-xs ${TC.text.muted}`}>
                        {selectedSymbol} {spread ? `spread ${spread}` : "waiting for depth"}
                    </div>
                </div>
                <div className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${orderBook?.status === "ready" ? TC.tone.success : TC.tone.warning}`}>
                    {orderBook?.status === "ready" ? "Live depth" : "Loading"}
                </div>
            </div>

            {error && <div className={`px-4 pt-3 text-xs ${TC.tone.danger}`}>{error}</div>}

            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                <OrderBookView asks={orderBook?.asks || []} bids={orderBook?.bids || []} />
                <TradeTapeView trades={tradeTape} />
            </div>
        </TerminalPanel>
    );
}

function OrderBookView({ asks, bids }) {
    const topAsks = asks.slice(0, 10).reverse();
    const topBids = bids.slice(0, 10);

    return (
        <div className="min-w-0 border-b border-neutral-100 p-4 dark:border-white/5">
            <div className={`grid grid-cols-3 pb-2 text-[11px] font-medium uppercase ${TC.text.muted}`}>
                <span>Price</span>
                <span className="text-right">Size</span>
                <span className="text-right">Total</span>
            </div>
            <div className="space-y-1">
                {topAsks.length === 0 ? (
                    <div className={`py-5 text-center text-xs ${TC.text.muted}`}>Waiting for asks</div>
                ) : topAsks.map(([price, quantity]) => (
                    <BookLevelRow key={`ask-${price}-${quantity}`} price={price} quantity={quantity} side="SELL" />
                ))}
            </div>
            <div className="my-2 h-px bg-neutral-100 dark:bg-white/5" />
            <div className="space-y-1">
                {topBids.length === 0 ? (
                    <div className={`py-5 text-center text-xs ${TC.text.muted}`}>Waiting for bids</div>
                ) : topBids.map(([price, quantity]) => (
                    <BookLevelRow key={`bid-${price}-${quantity}`} price={price} quantity={quantity} side="BUY" />
                ))}
            </div>
        </div>
    );
}

function BookLevelRow({ price, quantity, side }) {
    const total = Number(price) * Number(quantity);
    return (
        <div className="grid grid-cols-3 items-center text-xs">
            <span className={`font-mono ${side === "BUY" ? TC.tone.success : TC.tone.danger}`}>{formatPriceValue(price)}</span>
            <span className="text-right font-mono text-neutral-500">{trimNumericZeros(Number(quantity).toFixed(6))}</span>
            <span className="text-right font-mono text-neutral-500">{Number.isFinite(total) ? formatPriceValue(total) : "—"}</span>
        </div>
    );
}

function TradeTapeView({ trades }) {
    return (
        <div className="min-w-0 overflow-hidden p-4">
            <div className={`grid grid-cols-3 pb-2 text-[11px] font-medium uppercase ${TC.text.muted}`}>
                <span>Price</span>
                <span className="text-right">Size</span>
                <span className="text-right">Time</span>
            </div>
            <div className="custom-scrollbar max-h-[240px] space-y-1 overflow-auto pr-1">
                {trades.length === 0 ? (
                    <div className={`py-5 text-center text-xs ${TC.text.muted}`}>Waiting for trades</div>
                ) : trades.slice(0, 30).map((trade) => (
                    <div key={`${trade.id}-${trade.ts}`} className="grid grid-cols-3 items-center text-xs">
                        <span className={`font-mono ${trade.side === "SELL" ? TC.tone.danger : TC.tone.success}`}>{formatPriceValue(trade.price)}</span>
                        <span className="text-right font-mono text-neutral-500">{trimNumericZeros(Number(trade.quantity).toFixed(6))}</span>
                        <span className="text-right text-[11px] text-neutral-500">{Number.isFinite(trade.ts) ? new Date(trade.ts).toLocaleTimeString() : "—"}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function calculateSpread(bestBid, bestAsk) {
    const bid = Number(bestBid);
    const ask = Number(bestAsk);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= 0) return "";
    const spread = ask - bid;
    const spreadBps = (spread / ask) * 10000;
    return `${formatPriceValue(spread)} (${trimNumericZeros(spreadBps.toFixed(2))} bps)`;
}

function PositionsTableRows({ marketBoard, positionsError, positionsLoading, positionsPage, onSelectSymbol }) {
    if (positionsLoading) {
        return <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">Loading positions...</td></tr>;
    }

    if (positionsError) {
        return <tr><td colSpan={6} className={`px-5 py-8 text-center ${TC.tone.danger}`}>{positionsError}</td></tr>;
    }

    if (positionsPage.length === 0) {
        return <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">No open positions</td></tr>;
    }

    return positionsPage.map((position) => {
        const sym = String(position.symbol || "").toUpperCase();
        const realized = Number(position.realizedPnl || 0);
        const mark = Number(marketBoard[sym]?.price || 0);
        const entry = Number(position.avgPrice || 0);
        const qtyNum = Number(position.quantity || 0);
        const unrealized = Number.isFinite(mark) && Number.isFinite(entry) ? (mark - entry) * qtyNum : 0;

        return (
            <tr key={position.id || sym} className="hover:bg-neutral-50 dark:hover:bg-white/5 transition-colors">
                <td className={`px-5 py-3 font-medium cursor-pointer ${TC.symbolLink}`} onClick={() => onSelectSymbol(sym)}>{sym}</td>
                <td className="px-5 py-3 font-mono text-neutral-500">{trimNumericZeros(qtyNum.toFixed(6))}</td>
                <td className="px-5 py-3 font-mono">{trimNumericZeros(entry.toFixed(6))}</td>
                <td className="px-5 py-3 font-mono">{formatPriceValue(mark)}</td>
                <td className={`px-5 py-3 font-mono ${realized >= 0 ? TC.tone.success : TC.tone.danger}`}>{realized > 0 && "+"}{trimNumericZeros(realized.toFixed(4))}</td>
                <td className={`px-5 py-3 font-mono ${unrealized >= 0 ? TC.tone.success : TC.tone.danger}`}>{unrealized > 0 && "+"}{trimNumericZeros(unrealized.toFixed(4))}</td>
            </tr>
        );
    });
}

function OrdersTableRows({ copyOrderId, isDark, ordersById, ordersLoading, ordersPage, onSelectSymbol }) {
    if (ordersLoading) {
        return <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">Loading orders...</td></tr>;
    }

    if (ordersPage.length === 0) {
        return <tr><td colSpan={6} className="px-5 py-8 text-center text-neutral-500">No order history</td></tr>;
    }

    return ordersPage.map((order) => {
        const status = ordersById[order.orderId]?.status || order.status;

        return (
            <tr key={order.orderId} className="hover:bg-neutral-50 dark:hover:bg-white/5 transition-colors">
                <td className="px-5 py-3 font-mono text-xs text-neutral-500 flex items-center gap-2">
                    {String(order.orderId).slice(0, 8)}...
                    <CopyOrderButton orderId={order.orderId} isDark={isDark} onCopy={copyOrderId} />
                </td>
                <td className={`px-5 py-3 font-medium cursor-pointer ${TC.symbolLink}`} onClick={() => onSelectSymbol(order.symbol)}>{order.symbol}</td>
                <td className="px-5 py-3">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${order.side === "BUY" ? TC.side.buyBadge : TC.side.sellBadge}`}>
                        {order.side}
                    </span>
                </td>
                <td className="px-5 py-3 text-neutral-500 text-xs">{order.orderType}</td>
                <td className="px-5 py-3 font-mono">{order.quantity}</td>
                <td className="px-5 py-3 text-xs font-medium">
                    <span className={`px-2 py-1 rounded border ${status === "FILLED" ? TC.status.filled : status === "CANCELED" ? TC.status.cancelled : TC.status.pending}`}>
                        {status}
                    </span>
                </td>
            </tr>
        );
    });
}

function MarketBoardRows({ pinned, shown, togglePin, onSelectSymbol }) {
    if (shown.length === 0) {
        return <tr><td colSpan={4} className="px-5 py-8 text-center text-neutral-500">Waiting for market data...</td></tr>;
    }

    return shown.map(([sym, value]) => (
        <tr key={sym} className="hover:bg-neutral-50 dark:hover:bg-white/5 transition-colors">
            <td className="px-5 py-3">
                <button onClick={() => togglePin(sym)} className={`text-sm ${pinned.has(sym) ? "text-amber-400" : "text-neutral-600 dark:text-neutral-600 hover:text-neutral-400"}`}>
                    {pinned.has(sym) ? "★" : "☆"}
                </button>
            </td>
            <td className={`px-5 py-3 font-medium cursor-pointer ${TC.symbolLink}`} onClick={() => onSelectSymbol(sym)}>{sym}</td>
            <td className="px-5 py-3 font-mono">{formatPriceValue(value.price)}</td>
            <td className="px-5 py-3 text-xs text-neutral-500 tabular-nums">{value.ts ? new Date(value.ts).toLocaleTimeString() : "-"}</td>
        </tr>
    ));
}


import { FiCopy, FiCheck, FiArrowRight, FiArrowLeft, FiSun } from "react-icons/fi";
import { Fi } from "zod/v4/locales";

const CopyOrderButton = ({ orderId, isDark, onCopy }) => {
    const [copied, setCopied] = useState(false);

    const handleClick = () => {
        // 1. Perform the actual copy action
        if (onCopy) {
            onCopy(orderId);
        } else {
            // Fallback if no function passed
            navigator.clipboard.writeText(orderId);
        }

        // 2. Trigger the icon change
        setCopied(true);

        // 3. Revert back after 2 seconds
        setTimeout(() => {
            setCopied(false);
        }, 2000);
    };

    return (
        <button
            type="button"
            onClick={handleClick}
            className={`p-1 rounded transition-all duration-200 ${isDark
                ? "hover:bg-slate-800"
                : "hover:bg-slate-200"
                } ${copied
                    ? `${TC.tone.success} scale-110`
                    : isDark ? "text-slate-400" : "text-slate-500"
                }`}
            title={copied ? "Copied!" : "Copy order id"}
        >
            {copied ? <FiCheck className="w-4 h-4" /> : <FiCopy className="w-4 h-4" />}
        </button>
    );
};
