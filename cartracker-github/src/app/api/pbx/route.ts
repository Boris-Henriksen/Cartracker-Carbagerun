import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { applyUpdate, asteriskStatus, lanAddress, publicSettings, readSettings, reloadAsterisk, writeAsteriskConfig, writeSettings } from "@/lib/pbx";
import { carCallState, readCallLog } from "@/lib/pbx-events";

// PBX settings are admin-only and use the same code and wrong-code lockout as the gallery.
export async function GET(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);
  return NextResponse.json({
    settings: publicSettings(readSettings()),
    status: await asteriskStatus(),
    call: carCallState(),
    calls: readCallLog(),
    lanAddress: lanAddress(),
  });
}

export async function PUT(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const result = applyUpdate(readSettings(), body);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });

  writeSettings(result.settings);
  writeAsteriskConfig(result.settings);
  return NextResponse.json({ settings: publicSettings(result.settings), applied: await reloadAsterisk() });
}
