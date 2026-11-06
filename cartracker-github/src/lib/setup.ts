import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { DATA_DIR } from "@/lib/paths";

// Created by the installer on a fresh install; absent on older installs and in development (= no setup).
export const SETUP_FILE = path.join(DATA_DIR, "setup.json");
const COOKIE = "ct_setup";
const MAX_FAILURES = 10;
const LOCK_MINUTES = 15;

type SetupFile = {
  completed: boolean;
  codeSha256: string;
  expiresAt: string;
  sessionSha256?: string;
  failures?: number;
  lockedUntil?: number;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// The installer hashes the code the same way: upper case, letters and digits only.
const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function readSetup(): SetupFile | null {
  try {
    return JSON.parse(fs.readFileSync(SETUP_FILE, "utf8")) as SetupFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeSetup(setup: SetupFile) {
  const tempFile = `${SETUP_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(setup, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, SETUP_FILE);
}

function sameHash(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function setupPending(): boolean {
  const setup = readSetup();
  return setup !== null && !setup.completed;
}

/** Checks the one-time code from the installer and starts a setup session. Returns an error message or null. */
export async function unlockSetup(code: string, request: Request): Promise<string | null> {
  const setup = readSetup();
  if (!setup || setup.completed) return "Setup is already finished.";
  if ((setup.lockedUntil ?? 0) > Date.now()) return `Too many wrong codes. Try again in ${Math.ceil(((setup.lockedUntil ?? 0) - Date.now()) / 60_000)} minutes.`;
  if (Date.parse(setup.expiresAt) < Date.now()) {
    return "This setup code has expired. On the server, run: sudo bash deploy/install.sh --setup-code";
  }
  if (!sameHash(sha256(normalize(code)), setup.codeSha256)) {
    setup.failures = (setup.failures ?? 0) + 1;
    if (setup.failures >= MAX_FAILURES) {
      setup.lockedUntil = Date.now() + LOCK_MINUTES * 60_000;
      setup.failures = 0;
    }
    writeSetup(setup);
    return "Wrong setup code.";
  }

  const session = randomBytes(32).toString("hex");
  writeSetup({ ...setup, sessionSha256: sha256(session), failures: 0, lockedUntil: undefined });
  (await cookies()).set(COOKIE, session, {
    httpOnly: true,
    sameSite: "strict",
    secure: request.headers.get("x-forwarded-proto") === "https",
    maxAge: 60 * 60 * 12,
    path: "/",
  });
  return null;
}

export async function hasSetupSession(): Promise<boolean> {
  const setup = readSetup();
  if (!setup || setup.completed || !setup.sessionSha256) return false;
  const session = (await cookies()).get(COOKIE)?.value;
  return Boolean(session) && sameHash(sha256(session!), setup.sessionSha256);
}

/** Closes setup for good: the code and session stop working and /setup redirects away. */
export async function completeSetup() {
  const setup = readSetup();
  if (!setup) return;
  writeSetup({ completed: true, codeSha256: "", expiresAt: setup.expiresAt });
  (await cookies()).delete(COOKIE);
}
