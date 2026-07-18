"use client";

import Image from "next/image";
import Link from "next/link";
import { MdDarkMode, MdOutlineLightMode } from "react-icons/md";
import { useTheme } from "./lib/theme";

function ThemeToggle({ isDark, onToggle }) {
    return (
        <button type="button" onClick={onToggle} className="tc-icon-btn" aria-label="Toggle color theme">
            {isDark ? <MdDarkMode /> : <MdOutlineLightMode />}
        </button>
    );
}

function Logo({ isDark }) {
    return (
        <span className="tc-brand">
            <Image
                src="/logo.svg"
                alt="TradeCO"
                width={140}
                height={40}
                priority
                className={`h-7 w-auto ${isDark ? "invert" : ""}`}
            />
        </span>
    );
}

export default function LandingPage() {
    const { isDark, themeClass, toggleTheme } = useTheme();

    return (
        <main className={`${themeClass} tc-root`}>
            {/* Topbar */}
            <header className="tc-topbar">
                <div className="tc-container tc-topbar-row">
                    <Logo isDark={isDark} />
                    <nav className="tc-nav">
                        <a href="#features">Features</a>
                        <a href="#how">How it works</a>
                        <a href="#why">Why testnet</a>
                    </nav>
                    <div className="tc-top-actions">
                        <ThemeToggle isDark={isDark} onToggle={toggleTheme} />
                        <Link href="/login" className="tc-btn tc-btn-ghost" style={{ padding: "8px 14px" }}>
                            Sign in
                        </Link>
                        <Link href="/register" className="tc-btn tc-btn-accent" style={{ padding: "8px 16px" }}>
                            Get started
                        </Link>
                    </div>
                </div>
            </header>

            {/* Hero */}
            <section className="tc-hero">
                <div className="tc-container tc-hero-grid">
                    <div>
                        <div style={{ marginBottom: 20 }}>
                            <span className="tc-pill">
                                <span className="tc-dot" />
                                Binance Spot Testnet · live market data
                            </span>
                        </div>
                        <h1 className="tc-hero-title">
                            Trade crypto <span className="tc-accent-text">risk-free.</span>
                            <br />
                            Real markets, zero real money.
                        </h1>
                        <p className="tc-hero-sub">
                            A professional-grade spot trading terminal wired to the Binance Testnet. Practice
                            strategies, place real order types, and watch fills stream in — without risking a cent.
                        </p>
                        <div className="tc-hero-cta">
                            <Link href="/register" className="tc-btn tc-btn-accent">
                                Create free account
                            </Link>
                            <Link href="/login" className="tc-btn tc-btn-ghost">
                                I already have an account
                            </Link>
                        </div>
                        <div className="tc-hero-note">
                            <span><span className="tc-check">✓</span> No real funds</span>
                            <span><span className="tc-check">✓</span> Bring your own testnet keys</span>
                            <span><span className="tc-check">✓</span> Realtime WebSocket data</span>
                        </div>
                    </div>

                    {/* Mock terminal */}
                    <div className="tc-terminal" aria-hidden="true">
                        <div className="tc-term-head">
                            <div className="tc-term-sym">BTC<span className="tk">/USDT</span></div>
                            <div className="tc-term-px">
                                <div className="big tc-mono">64,182.50</div>
                                <div className="chg">▲ 2.14%</div>
                            </div>
                        </div>
                        <div className="tc-term-body">
                            <div className="tc-chart-wrap">
                                <div className="tc-ticks">
                                    <span className="t">15m</span>
                                    <span className="t on">1H</span>
                                    <span className="t">4H</span>
                                    <span className="t">1D</span>
                                </div>
                                <svg viewBox="0 0 300 150" width="100%" height="150" preserveAspectRatio="none">
                                    <g strokeWidth="6">
                                        <line x1="16" y1="70" x2="16" y2="118" stroke="var(--tc-trading-sell)" /><rect x="10" y="88" width="12" height="20" fill="var(--tc-trading-sell)" />
                                        <line x1="40" y1="60" x2="40" y2="112" stroke="var(--tc-trading-buy)" /><rect x="34" y="72" width="12" height="28" fill="var(--tc-trading-buy)" />
                                        <line x1="64" y1="66" x2="64" y2="104" stroke="var(--tc-trading-buy)" /><rect x="58" y="76" width="12" height="20" fill="var(--tc-trading-buy)" />
                                        <line x1="88" y1="78" x2="88" y2="120" stroke="var(--tc-trading-sell)" /><rect x="82" y="88" width="12" height="24" fill="var(--tc-trading-sell)" />
                                        <line x1="112" y1="58" x2="112" y2="98" stroke="var(--tc-trading-buy)" /><rect x="106" y="66" width="12" height="24" fill="var(--tc-trading-buy)" />
                                        <line x1="136" y1="50" x2="136" y2="90" stroke="var(--tc-trading-buy)" /><rect x="130" y="58" width="12" height="24" fill="var(--tc-trading-buy)" />
                                        <line x1="160" y1="60" x2="160" y2="96" stroke="var(--tc-trading-sell)" /><rect x="154" y="70" width="12" height="18" fill="var(--tc-trading-sell)" />
                                        <line x1="184" y1="44" x2="184" y2="84" stroke="var(--tc-trading-buy)" /><rect x="178" y="52" width="12" height="24" fill="var(--tc-trading-buy)" />
                                        <line x1="208" y1="38" x2="208" y2="74" stroke="var(--tc-trading-buy)" /><rect x="202" y="44" width="12" height="24" fill="var(--tc-trading-buy)" />
                                        <line x1="232" y1="48" x2="232" y2="80" stroke="var(--tc-trading-sell)" /><rect x="226" y="56" width="12" height="18" fill="var(--tc-trading-sell)" />
                                        <line x1="256" y1="30" x2="256" y2="66" stroke="var(--tc-trading-buy)" /><rect x="250" y="36" width="12" height="24" fill="var(--tc-trading-buy)" />
                                        <line x1="280" y1="24" x2="280" y2="58" stroke="var(--tc-trading-buy)" /><rect x="274" y="30" width="12" height="22" fill="var(--tc-trading-buy)" />
                                    </g>
                                </svg>
                            </div>
                            <div className="tc-order-panel">
                                <div className="tc-bs">
                                    <button type="button" className="buy">Buy</button>
                                    <button type="button">Sell</button>
                                </div>
                                <div className="tc-fake-input"><span>Price</span><b className="tc-mono">64,180.0</b></div>
                                <div className="tc-fake-input"><span>Amount</span><b className="tc-mono">0.125 BTC</b></div>
                                <div className="tc-fake-input"><span>Total</span><b className="tc-mono">8,022.5</b></div>
                                <button type="button" className="tc-place">Buy BTC</button>
                            </div>
                        </div>
                        <div className="tc-depth">
                            <div className="tc-lvl a"><div className="fill" /><span className="tc-mono">64,190.2</span><span className="tc-mono">0.842</span></div>
                            <div className="tc-lvl a"><div className="fill" style={{ width: "60%" }} /><span className="tc-mono">64,186.0</span><span className="tc-mono">1.204</span></div>
                            <div className="tc-lvl b"><div className="fill" style={{ width: "80%" }} /><span className="tc-mono">64,178.4</span><span className="tc-mono">2.010</span></div>
                            <div className="tc-lvl b"><div className="fill" style={{ width: "45%" }} /><span className="tc-mono">64,174.1</span><span className="tc-mono">0.663</span></div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Trust strip */}
            <div className="tc-strip">
                <div className="tc-container tc-strip-inner">
                    <span className="lbl">Built on</span>
                    <span>Binance Spot Testnet</span>
                    <span>Redis Streams</span>
                    <span>WebSocket realtime</span>
                    <span>Next.js 16</span>
                    <span>JWT auth</span>
                </div>
            </div>

            {/* Features */}
            <section className="tc-block" id="features">
                <div className="tc-container">
                    <div className="tc-sec-head">
                        <span className="tag">Everything you need</span>
                        <h2>A real terminal, minus the real risk</h2>
                        <p>
                            Every feature of a live desk — order types, realtime fills, portfolio tracking — running
                            safely against the Binance Testnet.
                        </p>
                    </div>
                    <div className="tc-feature-grid">
                        <div className="tc-card"><div className="ic c">⚡</div><h3>Realtime market data</h3><p>Live prices, candles, and order-book depth streamed over WebSocket with sub-second updates.</p></div>
                        <div className="tc-card"><div className="ic g">◪</div><h3>Advanced order types</h3><p>Market, limit, stop-loss, stop-limit, take-profit and maker orders — with time-in-force controls.</p></div>
                        <div className="tc-card"><div className="ic a">🔑</div><h3>Bring your own keys</h3><p>Connect your own Binance Testnet API keys. They&apos;re encrypted at rest and never leave your account.</p></div>
                        <div className="tc-card"><div className="ic g">▤</div><h3>Portfolio &amp; positions</h3><p>Track balances, open positions and realised P&amp;L, updated the instant an order fills.</p></div>
                        <div className="tc-card"><div className="ic c">◷</div><h3>Live order status</h3><p>Every order flows through a durable pipeline — watch it move from pending to filled in real time.</p></div>
                        <div className="tc-card"><div className="ic r">◈</div><h3>Dense pro layout</h3><p>A compact, keyboard-friendly workspace designed for focus — in polished dark or light themes.</p></div>
                    </div>
                </div>
            </section>

            {/* How it works */}
            <section className="tc-block" id="how" style={{ paddingTop: 10 }}>
                <div className="tc-container">
                    <div className="tc-sec-head">
                        <span className="tag">How it works</span>
                        <h2>From zero to your first order in minutes</h2>
                    </div>
                    <div className="tc-steps">
                        <div className="tc-step"><div className="n">1</div><h3>Create your account</h3><p>Sign up and paste your Binance Testnet API keys. Don&apos;t have any? Generate them free in a couple of clicks.</p></div>
                        <div className="tc-step"><div className="n">2</div><h3>Watch the markets</h3><p>Live charts, prices and depth stream straight into your terminal the moment you land.</p></div>
                        <div className="tc-step"><div className="n">3</div><h3>Place &amp; track orders</h3><p>Fire off any order type and follow every fill and status change in real time — risk-free.</p></div>
                    </div>
                </div>
            </section>

            {/* Stats */}
            <section className="tc-block" id="why" style={{ paddingTop: 10 }}>
                <div className="tc-container">
                    <div className="tc-stats">
                        <div className="tc-stat"><div className="v g">100%</div><div className="l">Testnet-safe</div></div>
                        <div className="tc-stat"><div className="v c">7+</div><div className="l">Order types</div></div>
                        <div className="tc-stat"><div className="v g">&lt;1s</div><div className="l">Data latency</div></div>
                        <div className="tc-stat"><div className="v c">$0</div><div className="l">Real money at risk</div></div>
                    </div>
                </div>
            </section>

            {/* CTA */}
            <section className="tc-block" style={{ paddingTop: 10 }}>
                <div className="tc-container">
                    <div className="tc-cta-band">
                        <h2>Ready to trade without the fear?</h2>
                        <p>Spin up your terminal and place your first testnet order today.</p>
                        <Link href="/register" className="tc-btn tc-btn-accent" style={{ padding: "13px 26px", fontSize: 15 }}>
                            Get started — it&apos;s free
                        </Link>
                    </div>
                </div>
            </section>

            {/* Footer */}
            <footer className="tc-footer">
                <div className="tc-container tc-foot">
                    <Logo isDark={isDark} />
                    <div className="links">
                        <a href="#features">Features</a>
                        <a href="#how">How it works</a>
                        <Link href="/login">Sign in</Link>
                        <Link href="/register">Get started</Link>
                    </div>
                    <div className="cr">Testnet only · Not financial advice · © 2026 TradeCO</div>
                </div>
            </footer>
        </main>
    );
}
