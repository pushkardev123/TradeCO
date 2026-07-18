"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import Image from "next/image";
import Link from "next/link";
import { MdDarkMode, MdOutlineLightMode } from "react-icons/md";
import { register } from "../lib/auth";
import { useTheme } from "../lib/theme";

// Signup schema: email + password + Binance keys
const signupSchema = z
    .object({
        email: z.string().email("Enter a valid email address"),
        password: z.string().min(6, "Password must be at least 6 characters long"),
        confirmPassword: z.string().min(6, "Confirm your password"),
        binanceApiKey: z.string().min(1, "Binance API key is required"),
        binanceSecretKey: z.string().min(1, "Binance secret key is required"),
    })
    .refine((v) => v.password === v.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
    });

// Defined at module scope (NOT inside SignupPage) so it keeps a stable
// identity across renders. If this lived inside the component it would be
// re-created on every keystroke, causing React to unmount/remount the input
// and lose focus after each character.
function InputField({ label, name, type = "text", placeholder, value, error, onChange, autoComplete = "off" }) {
    return (
        <div className="tc-field" style={{ marginBottom: 0 }}>
            <label htmlFor={name}>{label}</label>
            <div className={`tc-inp ${error ? "error" : ""}`}>
                <input
                    id={name}
                    name={name}
                    type={type}
                    value={value}
                    onChange={onChange}
                    placeholder={placeholder}
                    autoComplete={autoComplete}
                />
            </div>
            {error && <p className="tc-field-error">{error}</p>}
        </div>
    );
}

export default function SignupPage() {
    const router = useRouter();
    const { isDark, themeClass, toggleTheme } = useTheme();

    const [form, setForm] = useState({
        email: "",
        password: "",
        confirmPassword: "",
        binanceApiKey: "",
        binanceSecretKey: "",
    });
    const [errors, setErrors] = useState({});
    const [loading, setLoading] = useState(false);
    const [serverMsg, setServerMsg] = useState("");

    function handleChange(e) {
        setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
        // Clear specific field error when user types
        if (errors[e.target.name]) {
            setErrors((prev) => ({ ...prev, [e.target.name]: undefined }));
        }
    }

    async function onSubmit(e) {
        e.preventDefault();
        setErrors({});
        setServerMsg("");

        const parsed = signupSchema.safeParse(form);
        if (!parsed.success) {
            const fieldErrors = {};
            parsed.error.issues.forEach((err) => {
                const key = err.path?.[0] || "form";
                fieldErrors[key] = err.message;
            });
            setErrors(fieldErrors);
            return;
        }

        try {
            setLoading(true);
            await register({
                email: form.email,
                password: form.password,
                binanceApiKey: form.binanceApiKey,
                binanceSecretKey: form.binanceSecretKey,
            });
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

            <div className="tc-auth-card-wrap" style={{ maxWidth: 460 }}>
                <div className="tc-auth-head">
                    <span className="tc-brand">
                        <Image src="/logo.svg" alt="TradeCO" width={150} height={44} priority className={`h-8 w-auto ${isDark ? "invert" : ""}`} />
                    </span>
                    <h1>Create an account</h1>
                    <p>Enter your Binance Testnet keys to get started.</p>
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

                        <div className="tc-two">
                            <InputField label="Password" name="password" type="password" placeholder="••••••" value={form.password} error={errors.password} onChange={handleChange} autoComplete="new-password" />
                            <InputField label="Confirm" name="confirmPassword" type="password" placeholder="••••••" value={form.confirmPassword} error={errors.confirmPassword} onChange={handleChange} autoComplete="new-password" />
                        </div>

                        <div className="tc-divider">
                            <div className="ln" />
                            <span>API Keys</span>
                            <div className="ln" />
                        </div>

                        <div className="tc-keyrow">
                            <span className="lock">🔒</span> Encrypted at rest — stored separately from your account, never logged.
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            <InputField label="Binance API Key" name="binanceApiKey" placeholder="Paste your API Key" value={form.binanceApiKey} error={errors.binanceApiKey} onChange={handleChange} />
                            <InputField label="Binance Secret Key" name="binanceSecretKey" type="password" placeholder="Paste your Secret Key" value={form.binanceSecretKey} error={errors.binanceSecretKey} onChange={handleChange} />
                        </div>

                        <p className="tc-hint" style={{ marginTop: 12 }}>
                            Don&apos;t have Testnet keys?{" "}
                            <Link href="https://testnet.binance.vision" target="_blank">
                                Create them here →
                            </Link>
                        </p>

                        <button type="submit" disabled={loading} className="tc-submit accent" style={{ marginTop: 14 }}>
                            {loading ? "Creating account..." : "Create account"}
                        </button>
                    </form>

                    {serverMsg && <div className="tc-server-msg">{serverMsg}</div>}
                </div>

                <p className="tc-auth-foot">
                    Already have an account? <Link href="/login">Sign in</Link>
                </p>
            </div>
        </main>
    );
}
