"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { logout } from "../lib/auth";

export default function Logout() {
    const router = useRouter();

    useEffect(() => {
        let cancelled = false;

        logout().finally(() => {
            if (!cancelled) router.replace("/login");
        });

        return () => {
            cancelled = true;
        };
    }, [router]);

    return null;
}
