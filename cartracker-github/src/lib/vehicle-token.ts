import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "@/lib/paths";

// A token generated on the website; deleting this file falls back to TELEMETRY_INGEST_TOKEN.
const TOKEN_FILE = path.join(DATA_DIR, "vehicle-token.json");

type StoredToken = { token: string; changedAt: string };

export type VehicleToken = { token: string; source: "install" | "site"; changedAt?: string };

export function vehicleToken(): VehicleToken | null {
  try {
    const stored = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as StoredToken;
    return { token: stored.token, source: "site", changedAt: stored.changedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = process.env.TELEMETRY_INGEST_TOKEN;
  return token ? { token, source: "install" } : null;
}

/** The old token stops working immediately, so the MikroTik must be updated too. */
export function regenerateVehicleToken(): VehicleToken {
  const stored: StoredToken = { token: randomBytes(24).toString("base64url"), changedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const tempFile = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(tempFile, TOKEN_FILE);
  return { ...stored, source: "site" };
}
