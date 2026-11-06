import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { readSiteSettings, updateSiteSettings } from "@/lib/site-settings";

export async function GET(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);
  return NextResponse.json({ settings: readSiteSettings() });
}

export async function PUT(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const result = updateSiteSettings(await request.json().catch(() => null));
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ settings: result.settings });
}
