import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { mikrotikState } from "@/lib/mikrotik-state";
import { requestOrigin as origin } from "@/lib/server-info";
import { markMikrotikInstalled, updateSiteSettings } from "@/lib/site-settings";
import { getVehicleTracks } from "@/lib/telemetry";
import { regenerateVehicleToken } from "@/lib/vehicle-token";

// Includes the vehicle token, so never cache it.
function respond(request: NextRequest) {
  const { settings, urls, token, status } = mikrotikState(origin(request));
  const lastReports = getVehicleTracks().map((v) => ({ id: v.vehicleId, lastSeen: v.lastSeen }));
  return NextResponse.json({ settings, urls, token, status, lastReports }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);
  return respond(request);
}

export async function PUT(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const body = (await request.json().catch(() => ({}))) as { mikrotik?: unknown };
  const result = updateSiteSettings({ mikrotik: body?.mikrotik });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return respond(request);
}

// { action: "installed" } confirms the current script is on the router; { action: "regenerate-token" } makes a new token.
export async function POST(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (body?.action === "installed") markMikrotikInstalled(mikrotikState(origin(request)).fingerprint);
  else if (body?.action === "regenerate-token") regenerateVehicleToken();
  else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  return respond(request);
}
