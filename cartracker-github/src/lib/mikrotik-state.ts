import { INSTALL_MODE, PUBLIC_DOMAIN, telemetryUrls } from "@/lib/server-info";
import { mikrotikFingerprint, readSiteSettings } from "@/lib/site-settings";
import { vehicleToken } from "@/lib/vehicle-token";

export type MikrotikStatus = "never" | "current" | "outdated";

/** The script the router should have right now, and whether the admin confirmed it's installed. */
export function mikrotikState(requestOrigin: string) {
  const { mikrotik } = readSiteSettings();
  const token = vehicleToken()?.token ?? null;
  const urls = telemetryUrls(mikrotik.localUrl);
  // Development has no installer domain; an HTTPS address the admin is using works for the car too.
  if (!PUBLIC_DOMAIN && !INSTALL_MODE && requestOrigin.startsWith("https://")) urls.public = `${requestOrigin}/api/telemetry`;

  const connection = mikrotik.connection || (urls.public && INSTALL_MODE !== "local" ? "public" : "local");
  const url = connection === "public" ? urls.public : urls.local;
  const fingerprint = mikrotikFingerprint(url, token, mikrotik);
  const status: MikrotikStatus = !mikrotik.installedHash ? "never" : mikrotik.installedHash === fingerprint ? "current" : "outdated";
  return { settings: { ...mikrotik, connection }, urls, url, token, fingerprint, status };
}
