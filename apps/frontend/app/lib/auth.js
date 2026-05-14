import { jwtDecode } from "jwt-decode";
const TOKEN_KEY = "token";

export function setToken(token) {
    if (typeof window === "undefined") return;
    localStorage.setItem(TOKEN_KEY, token);
}

export function getToken() {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(TOKEN_KEY);
}

export function clearAuth() {
    if (typeof window === "undefined") return;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("userId");
}

// Decode JWT payload (frontend-only, no verification)
export function decodeToken(tokenOverride) {
    if (typeof window === "undefined") return null;

    const token = tokenOverride || localStorage.getItem("token");
    if (!token) return null;

    try {
        return jwtDecode(token);
    } catch (err) {
        console.error("Failed to decode token:", err);
        return null;
    }
}