import type { Metadata } from "next";
import type { ReactNode } from "react";
import AdminTabs from "@/components/AdminTabs";
import TopBar from "@/components/TopBar";

export const metadata: Metadata = {
  title: "Admin · CarTracker",
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <main className="shell">
      <TopBar />

      <section className="intro">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Manage your tracker.</h1>
        </div>
      </section>

      <AdminTabs />
      {children}
    </main>
  );
}
