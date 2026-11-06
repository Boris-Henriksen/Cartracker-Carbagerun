import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deleteRoutes, getVehicleTracks, resetTrack, savePoint, type TelemetryPoint } from "@/lib/telemetry";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { vehicleToken } from "@/lib/vehicle-token";

type IncomingPoint = Omit<TelemetryPoint, "timestamp"> & { timestamp?: string };

function isValidPoint(value: unknown): value is IncomingPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  const optionalNumber = (field: unknown) => field === undefined || typeof field === "number";
  return (
    typeof point.vehicleId === "string" && point.vehicleId.length > 0 &&
    typeof point.latitude === "number" && point.latitude >= -90 && point.latitude <= 90 &&
    typeof point.longitude === "number" && point.longitude >= -180 && point.longitude <= 180 &&
    typeof point.speed === "number" && point.speed >= 0 &&
    typeof point.heading === "number" && point.heading >= 0 && point.heading <= 360 &&
    (point.timestamp === undefined || (typeof point.timestamp === "string" && !Number.isNaN(Date.parse(point.timestamp)))) &&
    optionalNumber(point.altitude) &&
    optionalNumber(point.satellites) &&
    optionalNumber(point.fixQuality) &&
    optionalNumber(point.accuracy)
  );
}

// Fails closed: without a configured token no device can post positions.
function authorized(request: NextRequest) {
  const expected = vehicleToken()?.token;
  if (!expected) return false;
  const provided = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

export async function GET() {
  return NextResponse.json({ vehicles: getVehicleTracks() });
}

// Uses the same code and wrong-code lockout as the gallery.
export async function DELETE(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  let body: { vehicleId?: unknown; routeIds?: unknown; all?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const { vehicleId, routeIds, all } = body ?? {};
  if (typeof vehicleId !== "string" || vehicleId.length === 0) {
    return NextResponse.json({ error: "vehicleId is required" }, { status: 400 });
  }
  if (all === true) {
    resetTrack(vehicleId);
    return NextResponse.json({ ok: true });
  }
  if (!Array.isArray(routeIds) || routeIds.length === 0 || !routeIds.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "routeIds must be a non-empty list" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, deleted: deleteRoutes(vehicleId, routeIds) });
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (!isValidPoint(payload)) {
    return NextResponse.json({ error: "Invalid telemetry payload" }, { status: 400 });
  }

  // Devices without a reliable clock can leave out the timestamp; the receive time is used instead.
  return NextResponse.json({ vehicle: savePoint({ ...payload, timestamp: payload.timestamp ?? new Date().toISOString() }) }, { status: 201 });
}
