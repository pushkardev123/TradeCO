"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import Image from "next/image";
import Link from "next/link";
import { MdDarkMode, MdOutlineLightMode } from "react-icons/md";
import { login } from "../lib/auth";
import { useTheme } from "../lib/theme";

const loginSchema = z.object({
    email: z.string().email("Enter a valid email address"),
    password: z.string().min(6, "Password must be at least 6 characters long"),
});

export default function LoginPage() {
    const router = useRouter();
    const { isDark, themeClass, toggleTheme } = useTheme();

    const [form, setForm] = useState({ email: "", password: "" });
    const [errors, setErrors] = useState({});
    const [loading, setLoading] = useState(false);
    const [serverMsg, setServerMsg] = useState("");

    function handleChange(e) {
        setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
        if (errors[e.target.name]) {
            setErrors((prev) => ({ ...prev, [e.target.name]: undefined }));
        }
    }

    async function onSubmit(e) {
        e.preventDefault();
        setErrors({});
        setServerMsg("");

        const parsed = loginSchema.safeParse(form);
        if (!parsed.success) {
            const fieldErrors = {};
            parsed.error.issues.forEach((err) => {
                fieldErrors[err.path[0]] = err.message;
            });
            setErrors(fieldErrors);
            return;
        }

        try {
            setLoading(true);
            await login(form);
            router.push("/trade");
        } catch (err) {
            setServerMsg(err?.message || "Something went wrong. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className={`${themeClass} tc-root tc-auth`}>
            <div className="tc-auth-topbar">
                <Link href="/" className="tc-btn tc-btn-ghost" style={{ padding: "8px 14px" }}>
                    ← Home
                </Link>
                <button type="button" onClick={toggleTheme} className="tc-icon-btn" aria-label="Toggle color theme">
                    {isDark ? <MdDarkMode /> : <MdOutlineLightMode />}
                </button>
            </div>

            <div className="tc-auth-card-wrap">
                <div className="tc-auth-head">
                    <span className="tc-brand">
                        <Image src="/logo.svg" alt="TradeCO" width={150} height={44} priority className={`h-8 w-auto ${isDark ? "invert" : ""}`} />
                    </span>
                    <h1>Welcome back</h1>
                    <p>Enter your details to access your portfolio.</p>
                </div>

                <div className="tc-panel">
                    <form onSubmit={onSubmit} noValidate>
                        <div className="tc-field">
                            <label htmlFor="email">Email</label>
                            <div className={`tc-inp ${errors.email ? "error" : ""}`}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="3" y="5" width="18" height="14" rx="2" />
                                    <path d="m3 7 9 6 9-6" />
                                </svg>
                                <input
                                    id="email"
                                    name="email"
                                    type="email"
                                    value={form.email}
                                    onChange={handleChange}
                                    placeholder="name@example.com"
                                    autoComplete="email"
                                />
                            </div>
                            {errors.email && <p className="tc-field-error">{errors.email}</p>}
                        </div>

                        <div className="tc-field">
                            <label htmlFor="password">Password</label>
                            <div className={`tc-inp ${errors.password ? "error" : ""}`}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="4" y="10" width="16" height="10" rx="2" />
                                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                                </svg>
                                <input
                                    id="password"
                                    name="password"
                                    type="password"
                                    value={form.password}
                                    onChange={handleChange}
                                    placeholder="••••••••"
                                    autoComplete="current-password"
                                />
                            </div>
                            {errors.password && <p className="tc-field-error">{errors.password}</p>}
                        </div>

                        <button type="submit" disabled={loading} className="tc-submit">
                            {loading ? "Signing in..." : "Sign In"}
                        </button>
                    </form>

                    {serverMsg && <div className="tc-server-msg">{serverMsg}</div>}
                </div>

                <p className="tc-auth-foot">
                    Don&apos;t have an account? <Link href="/register">Sign up</Link>
                </p>
            </div>
        </main>
    );
}
