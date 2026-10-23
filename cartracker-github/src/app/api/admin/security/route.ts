import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode, clearLockouts, deviceKey, listLockouts, readSecuritySettings, updateSecuritySettings } from "@/lib/admin-auth";

async function blockedList(request: NextRequest) {
  const own = await deviceKey(request);
  return listLockouts().map((entry) => ({ ...entry, you: entry.key === own }));
}

export async function GET(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);
  return NextResponse.json({ settings: readSecuritySettings(), blocked: await blockedList(request) });
}

export async function PUT(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const body = await request.json().catch(() => null);
  const result = updateSecuritySettings(body);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ settings: result.settings, blocked: await blockedList(request) });
}

// Body { key } unblocks one entry; an empty body unblocks everything.
export async function DELETE(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const body = (await request.json().catch(() => ({}))) as { key?: unknown };
  clearLockouts(typeof body?.key === "string" ? body.key : undefined);
  return NextResponse.json({ blocked: await blockedList(request) });
}
