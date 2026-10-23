import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CarTracker",
  description: "Private-network GPS tracking dashboard for MikroTik LtAP vehicles.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
