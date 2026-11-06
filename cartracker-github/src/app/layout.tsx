import type { Metadata } from "next";
import { connection } from "next/server";
import { SiteProvider } from "@/components/SiteContext";
import { readSiteSettings } from "@/lib/site-settings";
import "./globals.css";

// The site name is a setting, so it's read per request instead of being baked in at build time.
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const { name } = readSiteSettings();
  return { title: { default: name, template: `%s · ${name}` }, description: "Live GPS tracking." };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  const { name, headline } = readSiteSettings();
  return (
    <html lang="en" data-theme="dark">
      <body>
        <SiteProvider value={{ name, headline }}>{children}</SiteProvider>
      </body>
    </html>
  );
}
