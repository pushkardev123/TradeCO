import { jwtDecode } from "jwt-decode";

let accessToken = null;
let currentUser = null;
let refreshPromise = null;

export class AuthApiError extends Error {
    constructor(message, status, data) {
        super(message);
        this.name = "AuthApiError";
        this.status = status;
        this.data = data;
    }
}

function backendBaseUrl() {
    return (process.env.NEXT_PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080").replace(/\/$/, "");
}

function cleanupLegacyAuthStorage() {
    if (typeof window === "undefined") return;
    try {
        localStorage.removeItem("token");
        localStorage.removeItem("userId");
    } catch { }
}

function resolveBackendPath(path) {
    if (typeof path !== "string") return path;
    if (/^https?:\/\//i.test(path)) return path;
    return `${backendBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseJson(res) {
    return res.json().catch(() => ({}));
}

function ensureOk(res, data, fallback) {
    if (res.ok && data?.ok !== false) return;
    throw new AuthApiError(data?.error || fallback || `Request failed (${res.status})`, res.status, data);
}

export function setToken(token) {
    accessToken = token || null;
    cleanupLegacyAuthStorage();
}

export function getToken() {
    cleanupLegacyAuthStorage();
    return accessToken;
}

export function clearAuth() {
    accessToken = null;
    currentUser = null;
    refreshPromise = null;
    cleanupLegacyAuthStorage();
}

// Decode JWT payload (frontend-only, no verification)
export function decodeToken(tokenOverride) {
    const token = tokenOverride || accessToken;
    if (!token) return null;

    try {
        return jwtDecode(token);
    } catch (err) {
        console.error("Failed to decode token:", err);
        return null;
    }
}

export function getCurrentUser() {
    return currentUser;
}

export function isAccessTokenExpiring(tokenOverride = accessToken, skewSeconds = 30) {
    const decoded = decodeToken(tokenOverride);
    if (!decoded?.exp) return true;
    return decoded.exp * 1000 <= Date.now() + skewSeconds * 1000;
}

export async function login(credentials) {
    const res = await fetch(resolveBackendPath("/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(credentials),
    });
    const data = await parseJson(res);
    ensureOk(res, data, "Login failed");

    setToken(data.accessToken || data.token);
    currentUser = data.user || null;
    return data;
}

export async function register(account) {
    const res = await fetch(resolveBackendPath("/auth/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(account),
    });
    const data = await parseJson(res);
    ensureOk(res, data, "Sign up failed");

    setToken(data.accessToken || data.token);
    currentUser = data.user || null;
    return data;
}

export async function refreshSession() {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        const res = await fetch(resolveBackendPath("/auth/refresh"), {
            method: "POST",
            credentials: "include",
        });
        const data = await parseJson(res);
        ensureOk(res, data, "Session refresh failed");

        setToken(data.accessToken || data.token);
        currentUser = data.user || currentUser;
        return data;
    })();

    try {
        return await refreshPromise;
    } catch (error) {
        clearAuth();
        throw error;
    } finally {
        refreshPromise = null;
    }
}

export async function ensureAccessToken() {
    if (accessToken && !isAccessTokenExpiring(accessToken)) return accessToken;
    await refreshSession();
    if (!accessToken) {
        throw new AuthApiError("Not authenticated", 401, null);
    }
    return accessToken;
}

export async function fetchMe() {
    const token = await ensureAccessToken();
    const res = await fetch(resolveBackendPath("/auth/me"), {
        method: "GET",
        headers: {
            Authorization: `Bearer ${token}`,
        },
        credentials: "include",
        cache: "no-store",
    });
    const data = await parseJson(res);
    ensureOk(res, data, "Failed to load session");

    currentUser = data.user || null;
    return data;
}

export async function bootstrapSession() {
    cleanupLegacyAuthStorage();
    if (!accessToken || isAccessTokenExpiring(accessToken)) {
        await refreshSession();
    }
    return fetchMe();
}

export async function logout() {
    const token = accessToken;
    try {
        await fetch(resolveBackendPath("/auth/logout"), {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            credentials: "include",
        });
    } finally {
        clearAuth();
    }
}

export async function authFetch(input, init = {}, options = {}) {
    const retry = options.retry !== false;
    const token = await ensureAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const res = await fetch(input, {
        ...init,
        headers,
        credentials: init.credentials || "include",
    });

    if (res.status !== 401 || !retry) return res;

    await refreshSession();
    const nextHeaders = new Headers(init.headers || {});
    nextHeaders.set("Authorization", `Bearer ${accessToken}`);
    if (init.body && !nextHeaders.has("Content-Type")) {
        nextHeaders.set("Content-Type", "application/json");
    }

    return fetch(input, {
        ...init,
        headers: nextHeaders,
        credentials: init.credentials || "include",
    });
}
