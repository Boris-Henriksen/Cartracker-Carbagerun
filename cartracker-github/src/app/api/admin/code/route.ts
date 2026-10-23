import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, changeAdminCode, checkAdminCode } from "@/lib/admin-auth";

// The Authorization header carries the current code, so a wrong one counts towards blocking like any other.
export async function POST(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const body = (await request.json().catch(() => ({}))) as { newCode?: unknown };
  const error = changeAdminCode(body?.newCode);
  if (error) return NextResponse.json({ error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
