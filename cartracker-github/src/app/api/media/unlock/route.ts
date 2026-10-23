import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";

export async function POST(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);
  return NextResponse.json({ ok: true });
}
