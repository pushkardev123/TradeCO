import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    TRADECO_BRAND_TOKENS,
    TRADECO_BRAND_VERSION,
    TRADECO_WEB_CLASSES,
    getTradecoThemeClass,
} from "./index.js";

test("exposes reusable brand token groups for web and future mobile clients", () => {
    assert.equal(TRADECO_BRAND_VERSION, "1");
    assert.equal(TRADECO_BRAND_TOKENS.color.surface.canvas.dark, "#09090b");
    assert.equal(TRADECO_BRAND_TOKENS.color.trading.buy.dark, "#34d399");
    assert.equal(TRADECO_BRAND_TOKENS.color.trading.sell.dark, "#fb7185");
    assert.equal(TRADECO_BRAND_TOKENS.radius.panel, "8px");
    assert.match(TRADECO_BRAND_TOKENS.typography.fontFamily.mono, /ui-monospace/);
});

test("keeps web class names stable and token-prefixed", () => {
    assert.equal(getTradecoThemeClass("dark"), "tradeco-theme-dark");
    assert.equal(getTradecoThemeClass("light"), "tradeco-theme-light");
    assert.equal(TRADECO_WEB_CLASSES.panel, "tradeco-panel");
    assert.equal(TRADECO_WEB_CLASSES.symbolLink, "tradeco-symbol-link");
    assert.equal(TRADECO_WEB_CLASSES.side.buyBadge, "tradeco-side-buy-badge");

    for (const key of ["shell", "panel", "input", "segment"]) {
        assert.match(TRADECO_WEB_CLASSES[key], /^tradeco-/);
    }
});

test("ships matching CSS variables and component classes", () => {
    const css = readFileSync(new URL("./tradeco-tokens.css", import.meta.url), "utf8");

    for (const snippet of [
        "--tc-surface-canvas",
        "--tc-trading-buy",
        "--tc-status-warning",
        ".tradeco-theme-dark",
        ".tradeco-panel",
        ".tradeco-input",
        ".tradeco-side-buy-badge",
    ]) {
        assert.match(css, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
});
