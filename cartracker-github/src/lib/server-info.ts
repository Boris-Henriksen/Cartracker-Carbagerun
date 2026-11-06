import { lanAddress } from "@/lib/pbx";
export { SIP_PORT } from "@/lib/pbx-constants";

// Written by the installer; unset in development.
export const INSTALL_MODE: "public" | "local" | null =
  process.env.CARTRACKER_MODE === "public" ? "public" : process.env.CARTRACKER_MODE === "local" ? "local" : null;
export const PUBLIC_DOMAIN = process.env.CARTRACKER_DOMAIN || null;
export const RTP_RANGE = { start: Number(process.env.RTP_START) || null, end: Number(process.env.RTP_END) || null };

/** The address the visitor used, as forwarded by nginx (or direct in development). */
export function requestOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost";
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** Telemetry URLs the car could use: through the public domain, and on the local network (directly or over a VPN). */
export function telemetryUrls(localOverride: string): { public: string | null; local: string | null } {
  const lan = lanAddress();
  return {
    public: PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}/api/telemetry` : null,
    local: localOverride || (lan ? `http://${lan}/api/telemetry` : null),
  };
}
