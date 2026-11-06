import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

// Proxy runs on its own, so it reads the setup file directly instead of importing app modules.
function setupPending(): boolean {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  try {
    return !(JSON.parse(fs.readFileSync(path.join(dataDir, "setup.json"), "utf8")) as { completed?: boolean }).completed;
  } catch {
    return false;
  }
}

/** Sends every page to /setup until the setup wizard is finished, and /setup away afterwards. */
export function proxy(request: NextRequest) {
  const onSetup = request.nextUrl.pathname === "/setup";
  const pending = setupPending();
  if (pending && !onSetup) return NextResponse.redirect(new URL("/setup", request.url));
  if (!pending && onSetup) return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

export const config = {
  // Pages only: API routes, Next.js assets and the favicon pass through.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
