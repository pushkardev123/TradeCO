"use client";

import { useCallback, useEffect, useState } from "react";
import { TRADECO_WEB_CLASSES } from "@tradeco/brand-tokens";

const THEME_STORAGE_KEY = "theme";

// Resolve the initial theme once, at mount, from the same `theme` localStorage
// key the trading terminal uses (falling back to the OS preference, then dark).
// Done as a lazy initializer rather than in an effect so we don't trigger a
// cascading re-render.
function readInitialTheme() {
    if (typeof window === "undefined") return "dark";
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === "dark" || stored === "light") return stored;
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    } catch {
        // Access to localStorage/matchMedia can throw in restricted contexts; keep the default.
    }
    return "dark";
}

// Shared theme hook used by the landing and auth screens. Persists to the same
// `theme` localStorage key the trading terminal uses so the choice is
// consistent across the whole app. Returns the resolved brand-tokens theme
// class (`tradeco-theme-dark` / `tradeco-theme-light`) so callers can apply it
// to their root element.
export function useTheme() {
    const [theme, setTheme] = useState(readInitialTheme);

    useEffect(() => {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch {
            // Ignore persistence failures.
        }
        if (typeof document !== "undefined") {
            document.documentElement.style.colorScheme = theme;
        }
    }, [theme]);

    const toggleTheme = useCallback(() => {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
    }, []);

    const isDark = theme === "dark";
    const themeClass = isDark ? TRADECO_WEB_CLASSES.theme.dark : TRADECO_WEB_CLASSES.theme.light;

    return { theme, isDark, themeClass, toggleTheme };
}
