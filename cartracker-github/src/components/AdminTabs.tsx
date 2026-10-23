"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ADMIN_TABS = [
  { href: "/admin/overview", label: "Overview" },
  { href: "/admin/pbx", label: "Phone (PBX)" },
  { href: "/admin/security", label: "Security" },
];

export default function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav className="nav-tabs admin-tabs" aria-label="Admin sections">
      {ADMIN_TABS.map((tab) => (
        <Link key={tab.href} href={tab.href} className={`nav-tab${pathname === tab.href ? " active" : ""}`} aria-current={pathname === tab.href ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
