import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, adminCodeInfo, checkAdminCode } from "@/lib/admin-auth";
import { listMedia, MEDIA_DIR } from "@/lib/media";
import { DATA_DIR } from "@/lib/paths";
import { amiCredentials, asteriskInfo, lanAddress, MOH_DIR, readSettings, SOUNDS_DIR } from "@/lib/pbx";
import { SIP_PORT } from "@/lib/pbx-constants";
import { readCallLog } from "@/lib/pbx-events";
import { getVehicleTracks, TRACKS_FILE } from "@/lib/telemetry";
import { vehicleToken } from "@/lib/vehicle-token";

async function sizeOf(target: string): Promise<number> {
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  const entries = await fs.promises.readdir(target);
  const sizes = await Promise.all(entries.map((entry) => sizeOf(path.join(target, entry))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function readVersion(packageJson: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

// The address the admin opened the site with, so it's right on every install (behind nginx or not).
function siteOrigin(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "localhost";
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  return { host: host.replace(/:\d+$/, ""), origin: `${proto}://${host}` };
}

export async function GET(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const { host, origin } = siteOrigin(request);
  const pbxInstalled = amiCredentials() !== null;
  const [asterisk, disk, sizes] = await Promise.all([
    pbxInstalled ? asteriskInfo() : Promise.resolve(null),
    fs.promises.statfs(fs.existsSync(DATA_DIR) ? DATA_DIR : process.cwd()),
    Promise.all([sizeOf(TRACKS_FILE), sizeOf(MEDIA_DIR), sizeOf(MOH_DIR), sizeOf(SOUNDS_DIR), sizeOf(DATA_DIR)]),
  ]);
  const vehicles = getVehicleTracks();
  const token = vehicleToken();

  return NextResponse.json({
    site: { host, origin, telemetryUrl: `${origin}/api/telemetry`, lanAddress: lanAddress() },
    vehicle: {
      tokenSet: token !== null,
      tokenSource: token?.source ?? null,
      tokenChangedAt: token?.changedAt ?? null,
      vehicles: vehicles.map((v) => ({ id: v.vehicleId, lastSeen: v.lastSeen, latest: v.latest })),
    },
    checklist: {
      pbxInstalled,
      sipHost: readSettings().network.externalAddress || null,
      sipPort: SIP_PORT,
      rtpStart: asterisk?.rtpStart ?? null,
      rtpEnd: asterisk?.rtpEnd ?? null,
    },
    server: {
      dataDir: DATA_DIR,
      diskFree: disk.bavail * disk.bsize,
      diskTotal: disk.blocks * disk.bsize,
      sizes: { tracks: sizes[0], media: sizes[1], holdMusic: sizes[2], greeting: sizes[3], data: sizes[4] },
      versions: {
        app: readVersion(path.join(process.cwd(), "package.json")),
        next: readVersion(path.join(process.cwd(), "node_modules", "next", "package.json")),
        node: process.version,
        asterisk: asterisk?.version ?? null,
      },
      uptimeSeconds: Math.round(process.uptime()),
    },
    counts: {
      routes: vehicles.reduce((sum, v) => sum + v.routes.length, 0),
      points: vehicles.reduce((sum, v) => sum + v.track.length, 0),
      media: listMedia().length,
      calls: readCallLog().length,
    },
    adminCode: adminCodeInfo(),
  });
}
