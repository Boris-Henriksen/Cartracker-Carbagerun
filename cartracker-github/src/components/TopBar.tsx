"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { initials, useSite } from "@/components/SiteContext";

type Theme = "dark" | "light";

const NAV_ITEMS = [
  { href: "/", label: "Tracking" },
  { href: "/control", label: "Control" },
  { href: "/media", label: "Gallery" },
  { href: "/admin", label: "Admin" },
];

// The theme lives on <html data-theme>, which survives client-side navigation between pages.
const themeListeners = new Set<() => void>();

function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, readTheme, () => "dark");
}

export default function TopBar({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const theme = useTheme();
  const site = useSite();

  function toggleTheme() {
    document.documentElement.dataset.theme = theme === "dark" ? "light" : "dark";
    themeListeners.forEach((listener) => listener());
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand"><span className="brand-mark">{initials(site.name)}</span><span>{site.name}</span></div>
        <nav className="nav-tabs" aria-label="Pages">
          {NAV_ITEMS.map((item) => {
            // Admin stays highlighted on its sub-pages (/admin/pbx, /admin/security).
            const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
            return (
              <Link key={item.href} href={item.href} className={`nav-tab${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="topbar-actions">
        <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
          <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
        </button>
        {children}
      </div>
    </header>
  );
}
