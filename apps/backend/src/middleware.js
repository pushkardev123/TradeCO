import { verifyToken } from "./jwt.js";

export function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
        return res.status(401).json({ ok: false, error: "Missing Bearer token" });
    }

    try {
        const decoded = verifyToken(token);
        const userId = decoded?.userId || decoded?.id || decoded?.sub;
        if (!userId) {
            return res.status(401).json({ ok: false, error: "Token missing user identity" });
        }

        req.user = { id: String(userId), email: decoded?.email || null };
        return next();
    } catch {
        return res.status(401).json({ ok: false, error: "Invalid/expired token" });
    }
}
