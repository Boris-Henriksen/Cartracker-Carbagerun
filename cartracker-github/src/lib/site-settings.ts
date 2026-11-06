import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "@/lib/paths";

const SITE_FILE = path.join(DATA_DIR, "site.json");

export type MikrotikSettings = {
  // "" = follow the install mode (domain when public, LAN/VPN when local).
  connection: "public" | "local" | "";
  localUrl: string;
  vehicleId: string;
  intervalSeconds: number;
  // Fingerprint of the script the admin confirmed is on the router; "" = never confirmed.
  installedHash: string;
};

export type SiteSettings = {
  name: string;
  headline: string;
  routeGapHours: number;
  minMoveMeters: number;
  maxPoints: number;
  mikrotik: MikrotikSettings;
};

export const DEFAULT_SITE: SiteSettings = {
  name: "CarTracker",
  headline: "Track your vehicle.",
  routeGapHours: 2,
  minMoveMeters: 15,
  maxPoints: 5000,
  mikrotik: { connection: "", localUrl: "", vehicleId: "car-1", intervalSeconds: 15, installedHash: "" },
};

// Read on every call (tiny file) so changes apply without a restart.
export function readSiteSettings(): SiteSettings {
  try {
    const saved = JSON.parse(fs.readFileSync(SITE_FILE, "utf8")) as Partial<SiteSettings>;
    return { ...DEFAULT_SITE, ...saved, mikrotik: { ...DEFAULT_SITE.mikrotik, ...saved.mikrotik } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SITE);
    throw error;
  }
}

/** Validates a partial update, merges it into the saved settings and writes them. */
export function updateSiteSettings(body: unknown): { settings: SiteSettings } | { error: string } {
  const input = (body ?? {}) as Partial<Record<keyof SiteSettings, unknown>>;
  const current = readSiteSettings();
  const mikrotikInput = (input.mikrotik ?? {}) as Record<string, unknown>;
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value.trim() : fallback);
  const number = (value: unknown, fallback: number) => (value === undefined ? fallback : Number(value));

  const next: SiteSettings = {
    name: text(input.name, current.name),
    headline: text(input.headline, current.headline),
    routeGapHours: number(input.routeGapHours, current.routeGapHours),
    minMoveMeters: number(input.minMoveMeters, current.minMoveMeters),
    maxPoints: number(input.maxPoints, current.maxPoints),
    mikrotik: {
      connection: mikrotikInput.connection === undefined
        ? current.mikrotik.connection
        : mikrotikInput.connection === "public" || mikrotikInput.connection === "local" ? mikrotikInput.connection : "",
      vehicleId: text(mikrotikInput.vehicleId, current.mikrotik.vehicleId),
      intervalSeconds: number(mikrotikInput.intervalSeconds, current.mikrotik.intervalSeconds),
      localUrl: text(mikrotikInput.localUrl, current.mikrotik.localUrl),
      installedHash: current.mikrotik.installedHash,
    },
  };

  const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  if (next.name.length < 1 || next.name.length > 40) return { error: "Site name must be 1-40 characters" };
  if (next.headline.length < 1 || next.headline.length > 80) return { error: "Headline must be 1-80 characters" };
  if (!between(next.routeGapHours, 0.25, 48)) return { error: "New route after must be 0.25-48 hours" };
  if (!between(next.minMoveMeters, 0, 500)) return { error: "Minimum movement must be 0-500 metres" };
  if (!Number.isInteger(next.maxPoints) || !between(next.maxPoints, 500, 100_000)) return { error: "Max points must be 500-100000" };
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(next.mikrotik.vehicleId)) return { error: "Vehicle name may only use letters, digits, - and _" };
  if (!Number.isInteger(next.mikrotik.intervalSeconds) || !between(next.mikrotik.intervalSeconds, 5, 3600)) {
    return { error: "Report interval must be 5-3600 seconds" };
  }
  if (next.mikrotik.localUrl && !/^https?:\/\/[^\s"\\]+$/.test(next.mikrotik.localUrl)) return { error: "Local address must start with http:// or https://" };

  writeSite(next);
  return { settings: next };
}

function writeSite(settings: SiteSettings) {
  fs.mkdirSync(path.dirname(SITE_FILE), { recursive: true });
  const tempFile = `${SITE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2));
  fs.renameSync(tempFile, SITE_FILE);
}

/** Everything the MikroTik script depends on; any change means the router needs the new script. */
export function mikrotikFingerprint(url: string | null, token: string | null, mikrotik: MikrotikSettings): string {
  return createHash("sha256").update(JSON.stringify([url, token, mikrotik.vehicleId, mikrotik.intervalSeconds])).digest("hex");
}

export function markMikrotikInstalled(fingerprint: string) {
  const settings = readSiteSettings();
  settings.mikrotik.installedHash = fingerprint;
  writeSite(settings);
}
