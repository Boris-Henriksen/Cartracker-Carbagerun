import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { DATA_DIR } from "@/lib/paths";

const SETTINGS_FILE = path.join(DATA_DIR, "security.json");
const LOCKOUT_FILE = path.join(DATA_DIR, "lockout.json");
// A code changed on the website; deleting this file falls back to MEDIA_UPLOAD_TOKEN.
const CODE_FILE = path.join(DATA_DIR, "admin-code.json");
const DEVICE_COOKIE = "ct_device";

export type BlockMode = "device" | "network";

export type SecuritySettings = {
  mode: BlockMode;
  maxAttempts: number;
  lockMinutes: number;
  // Device mode only: a much higher per-network limit for scripts that throw the device cookie away.
  networkMaxAttempts: number;
};

const DEFAULT_SECURITY: SecuritySettings = { mode: "device", maxAttempts: 5, lockMinutes: 15, networkMaxAttempts: 30 };

export type LockoutEntry = {
  key: string;
  kind: BlockMode;
  failures: number;
  lastFailure: number;
  lockedUntil?: number;
  ip: string;
  userAgent: string;
};

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(file: string, value: unknown, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tempFile, file);
}

type StoredCode = { salt: string; hash: string; changedAt: string };

function adminCodeConfigured(): boolean {
  return fs.existsSync(CODE_FILE) || Boolean(process.env.MEDIA_UPLOAD_TOKEN);
}

export function adminCodeInfo(): { source: "install" | "site"; changedAt?: string } {
  const stored = readJson<StoredCode | null>(CODE_FILE, null);
  return stored ? { source: "site", changedAt: stored.changedAt } : { source: "install" };
}

function adminCodeMatches(provided: string): boolean {
  const stored = readJson<StoredCode | null>(CODE_FILE, null);
  if (stored) {
    const hash = scryptSync(provided, Buffer.from(stored.salt, "hex"), 64);
    return timingSafeEqual(hash, Buffer.from(stored.hash, "hex"));
  }
  const given = Buffer.from(provided);
  const wanted = Buffer.from(process.env.MEDIA_UPLOAD_TOKEN ?? "");
  return wanted.length > 0 && given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Returns an error message, or null when the new code was saved. */
export function changeAdminCode(code: unknown): string | null {
  if (typeof code !== "string" || code.length < 12 || code.length > 128) return "The new code must be 12-128 characters";
  if (code.trim() !== code) return "The new code can't start or end with a space";
  const salt = randomBytes(16);
  const stored: StoredCode = { salt: salt.toString("hex"), hash: scryptSync(code, salt, 64).toString("hex"), changedAt: new Date().toISOString() };
  writeJson(CODE_FILE, stored, 0o600);
  return null;
}

export function readSecuritySettings(): SecuritySettings {
  return { ...DEFAULT_SECURITY, ...readJson<Partial<SecuritySettings>>(SETTINGS_FILE, {}) };
}

export function updateSecuritySettings(body: unknown): { settings: SecuritySettings } | { error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const settings: SecuritySettings = {
    mode: input.mode === "network" ? "network" : "device",
    maxAttempts: Number(input.maxAttempts),
    lockMinutes: Number(input.lockMinutes),
    networkMaxAttempts: Number(input.networkMaxAttempts),
  };
  const inRange = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  if (!inRange(settings.maxAttempts, 3, 20)) return { error: "Wrong codes before blocking must be 3-20" };
  if (!inRange(settings.lockMinutes, 1, 1440)) return { error: "Block time must be 1-1440 minutes" };
  if (!inRange(settings.networkMaxAttempts, 10, 500)) return { error: "Network safety limit must be 10-500" };
  writeJson(SETTINGS_FILE, settings);
  return { settings };
}

// Drops blocks that have run out and failure counts older than the block time.
function activeEntries(now: number, settings: SecuritySettings): Record<string, LockoutEntry> {
  const entries = readJson<Record<string, LockoutEntry>>(LOCKOUT_FILE, {});
  for (const [key, entry] of Object.entries(entries)) {
    const expired = entry.lockedUntil ? entry.lockedUntil <= now : now - entry.lastFailure > settings.lockMinutes * 60_000;
    if (expired) delete entries[key];
  }
  return entries;
}

export function listLockouts(): LockoutEntry[] {
  return Object.values(activeEntries(Date.now(), readSecuritySettings())).sort((a, b) => b.lastFailure - a.lastFailure);
}

export function clearLockouts(key?: string) {
  if (!key) return writeJson(LOCKOUT_FILE, {});
  const entries = activeEntries(Date.now(), readSecuritySettings());
  delete entries[key];
  writeJson(LOCKOUT_FILE, entries);
}

// nginx overwrites X-Real-IP with the real client address; cloudflared sets CF-Connecting-IP.
function clientIp(request: Request): string {
  return request.headers.get("x-real-ip") ?? request.headers.get("cf-connecting-ip") ?? "local";
}

/** Anonymous per-browser ID, so one person guessing doesn't block everyone sharing their network. */
export async function deviceKey(request: Request): Promise<string> {
  const store = await cookies();
  let id = store.get(DEVICE_COOKIE)?.value;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    id = randomUUID();
    store.set(DEVICE_COOKIE, id, {
      httpOnly: true,
      sameSite: "strict",
      secure: request.headers.get("x-forwarded-proto") === "https",
      maxAge: 60 * 60 * 24 * 365,
      path: "/",
    });
  }
  return `device:${id}`;
}

export type AdminAuthResult =
  | { status: "ok" }
  | { status: "unauthorized"; remaining: number }
  | { status: "locked"; minutes: number }
  | { status: "disabled" };

/** Checks the admin code. Fails closed when no code is configured. */
export async function checkAdminCode(request: Request): Promise<AdminAuthResult> {
  if (!adminCodeConfigured()) return { status: "disabled" };

  const settings = readSecuritySettings();
  const now = Date.now();
  const ip = clientIp(request);
  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 160);
  const buckets: { key: string; kind: BlockMode; limit: number }[] = [
    { key: `network:${ip}`, kind: "network", limit: settings.mode === "network" ? settings.maxAttempts : settings.networkMaxAttempts },
  ];
  if (settings.mode === "device") buckets.unshift({ key: await deviceKey(request), kind: "device", limit: settings.maxAttempts });

  const entries = activeEntries(now, settings);
  // Checked before the code so a blocked client can't keep guessing.
  const lockedUntil = Math.max(0, ...buckets.map((bucket) => entries[bucket.key]?.lockedUntil ?? 0));
  if (lockedUntil > now) return { status: "locked", minutes: Math.ceil((lockedUntil - now) / 60_000) };

  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (adminCodeMatches(provided)) {
    // Only the primary bucket is cleared, so a correct code doesn't wipe a network's safety count.
    if (entries[buckets[0].key]) {
      delete entries[buckets[0].key];
      writeJson(LOCKOUT_FILE, entries);
    }
    return { status: "ok" };
  }

  let remaining = Infinity;
  for (const { key, kind, limit } of buckets) {
    const entry = entries[key] ?? { key, kind, failures: 0, lastFailure: now, ip, userAgent };
    entry.failures += 1;
    entry.lastFailure = now;
    entry.ip = ip;
    entry.userAgent = userAgent;
    if (entry.failures >= limit) entry.lockedUntil = now + settings.lockMinutes * 60_000;
    entries[key] = entry;
    remaining = Math.min(remaining, limit - entry.failures);
  }
  writeJson(LOCKOUT_FILE, entries);
  return remaining > 0 ? { status: "unauthorized", remaining } : { status: "locked", minutes: settings.lockMinutes };
}

export function adminAuthError(result: Exclude<AdminAuthResult, { status: "ok" }>): Response {
  switch (result.status) {
    case "disabled":
      return Response.json({ error: "Admin features are disabled: MEDIA_UPLOAD_TOKEN is not set" }, { status: 503 });
    case "locked":
      return Response.json(
        { error: `Too many wrong codes. Try again in ${result.minutes} ${result.minutes === 1 ? "minute" : "minutes"}` },
        { status: 403 }
      );
    case "unauthorized":
      return Response.json(
        { error: `Wrong code, ${result.remaining} ${result.remaining === 1 ? "attempt" : "attempts"} left` },
        { status: 401 }
      );
  }
}
