export const TRADECO_BRAND_VERSION = "1";

const freeze = (value) => Object.freeze(value);

export const TRADECO_BRAND_TOKENS = freeze({
    color: freeze({
        surface: freeze({
            canvas: freeze({ light: "#f5f6f8", dark: "#09090b" }),
            panel: freeze({ light: "#ffffff", dark: "#111214" }),
            panelRaised: freeze({ light: "#ffffff", dark: "#15171a" }),
            muted: freeze({ light: "#f3f4f6", dark: "#181b1f" }),
            input: freeze({ light: "#fafafa", dark: "#08090b" }),
        }),
        text: freeze({
            primary: freeze({ light: "#18181b", dark: "#f4f4f5" }),
            secondary: freeze({ light: "#3f3f46", dark: "#d4d4d8" }),
            muted: freeze({ light: "#71717a", dark: "#71717a" }),
            subtle: freeze({ light: "#a1a1aa", dark: "#a1a1aa" }),
            inverse: freeze({ light: "#ffffff", dark: "#09090b" }),
        }),
        border: freeze({
            subtle: freeze({ light: "rgba(24,24,27,0.08)", dark: "rgba(255,255,255,0.10)" }),
            muted: freeze({ light: "rgba(24,24,27,0.06)", dark: "rgba(255,255,255,0.06)" }),
            focus: freeze({ light: "rgba(8,145,178,0.40)", dark: "rgba(103,232,249,0.48)" }),
        }),
        trading: freeze({
            buy: freeze({ light: "#059669", dark: "#34d399" }),
            sell: freeze({ light: "#e11d48", dark: "#fb7185" }),
            buyWash: freeze({ light: "rgba(5,150,105,0.10)", dark: "rgba(52,211,153,0.14)" }),
            sellWash: freeze({ light: "rgba(225,29,72,0.10)", dark: "rgba(251,113,133,0.14)" }),
        }),
        status: freeze({
            live: freeze({ light: "#059669", dark: "#34d399" }),
            sync: freeze({ light: "#0891b2", dark: "#22d3ee" }),
            warning: freeze({ light: "#d97706", dark: "#f59e0b" }),
            error: freeze({ light: "#e11d48", dark: "#fb7185" }),
            neutral: freeze({ light: "#71717a", dark: "#a1a1aa" }),
        }),
    }),
    spacing: freeze({
        panelPadding: "1.25rem",
        sectionGap: "1.5rem",
        controlGap: "0.25rem",
        controlPaddingX: "0.75rem",
        controlPaddingY: "0.625rem",
    }),
    radius: freeze({
        panel: "8px",
        control: "8px",
        pill: "999px",
        badge: "4px",
    }),
    typography: freeze({
        fontFamily: freeze({
            sans: "\"Inter\", \"SF Pro Display\", \"Segoe UI\", ui-sans-serif, system-ui, sans-serif",
            mono: "\"SFMono-Regular\", \"Cascadia Code\", \"Roboto Mono\", ui-monospace, monospace",
        }),
        size: freeze({
            label: "0.75rem",
            body: "0.875rem",
            sectionTitle: "1rem",
            display: "1.125rem",
        }),
    }),
});

export const TRADECO_WEB_CLASSES = freeze({
    theme: freeze({
        dark: "tradeco-theme-dark",
        light: "tradeco-theme-light",
    }),
    authShell: "tradeco-auth-shell",
    shell: "tradeco-shell",
    topbar: "tradeco-topbar",
    panel: "tradeco-panel",
    dropdown: "tradeco-dropdown",
    segment: "tradeco-segment",
    segmentActive: "tradeco-segment-active",
    segmentInactive: "tradeco-segment-inactive",
    input: "tradeco-input",
    readonlyInput: "tradeco-input tradeco-input-readonly",
    statusPill: "tradeco-status-pill",
    iconButton: "tradeco-icon-button",
    iconButtonActive: "tradeco-icon-button tradeco-icon-button-active",
    tableHeader: "tradeco-table-header",
    submitButton: "tradeco-submit-button",
    primaryButton: "tradeco-primary-button",
    secondaryButton: "tradeco-secondary-button",
    symbolLink: "tradeco-symbol-link",
    text: freeze({
        primary: "tradeco-text-primary",
        secondary: "tradeco-text-secondary",
        muted: "tradeco-text-muted",
        subtle: "tradeco-text-subtle",
        inverse: "tradeco-text-inverse",
    }),
    tone: freeze({
        success: "tradeco-tone-success",
        danger: "tradeco-tone-danger",
        warning: "tradeco-tone-warning",
        info: "tradeco-tone-info",
        neutral: "tradeco-tone-neutral",
    }),
    side: freeze({
        buyActive: "tradeco-side-buy-active",
        sellActive: "tradeco-side-sell-active",
        buyBadge: "tradeco-side-buy-badge",
        sellBadge: "tradeco-side-sell-badge",
    }),
    tab: freeze({
        active: "tradeco-tab-active",
        activeAccent: "tradeco-tab-active-accent",
        inactive: "tradeco-tab-inactive",
    }),
    status: freeze({
        filled: "tradeco-order-status-filled",
        cancelled: "tradeco-order-status-cancelled",
        pending: "tradeco-order-status-pending",
    }),
});

export function getTradecoThemeClass(theme) {
    return theme === "dark" ? TRADECO_WEB_CLASSES.theme.dark : TRADECO_WEB_CLASSES.theme.light;
}
