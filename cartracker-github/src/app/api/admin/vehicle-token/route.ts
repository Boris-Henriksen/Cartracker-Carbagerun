import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { regenerateVehicleToken, vehicleToken } from "@/lib/vehicle-token";

// POST rather than GET so the token never ends up in caches or logs as a plain page load.
export async function POST(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  const token = body?.action === "regenerate" ? regenerateVehicleToken() : vehicleToken();
  if (!token) return NextResponse.json({ error: "No vehicle token is set yet. Press 'Generate new' to create one." }, { status: 404 });
  return NextResponse.json(token);
}
