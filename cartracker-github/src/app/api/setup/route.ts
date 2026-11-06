import { NextRequest, NextResponse } from "next/server";
import { adminCodeInfo, readSecuritySettings } from "@/lib/admin-auth";
import { mikrotikState } from "@/lib/mikrotik-state";
import { amiCredentials, lanAddress, publicSettings, readSettings } from "@/lib/pbx";
import { SIP_PORT } from "@/lib/pbx-constants";
import { INSTALL_MODE, PUBLIC_DOMAIN, RTP_RANGE, requestOrigin } from "@/lib/server-info";
import { hasSetupSession, setupPending } from "@/lib/setup";
import { readSiteSettings } from "@/lib/site-settings";

// Everything the setup wizard needs; details only after the setup code was entered.
export async function GET(request: NextRequest) {
  if (!setupPending()) return NextResponse.json({ pending: false });
  if (!(await hasSetupSession())) return NextResponse.json({ pending: true, unlocked: false });

  const mikrotik = mikrotikState(requestOrigin(request));
  const pbx = publicSettings(readSettings());
  return NextResponse.json(
    {
      pending: true,
      unlocked: true,
      install: {
        mode: INSTALL_MODE ?? "local",
        domain: PUBLIC_DOMAIN,
        lanAddress: lanAddress(),
        pbxInstalled: amiCredentials() !== null,
        sipPort: SIP_PORT,
        rtpStart: RTP_RANGE.start,
        rtpEnd: RTP_RANGE.end,
      },
      adminCodeSet: adminCodeInfo().source === "site" || Boolean(process.env.MEDIA_UPLOAD_TOKEN),
      site: readSiteSettings(),
      security: readSecuritySettings(),
      pbx: {
        mode: pbx.mode,
        extension: pbx.phone.extension,
        testExtension: pbx.test.extension,
        externalAddress: pbx.network.externalAddress || PUBLIC_DOMAIN || "",
        trunk: { host: pbx.trunk.host, port: pbx.trunk.port, username: pbx.trunk.username, number: pbx.trunk.number },
      },
      mikrotik: { settings: mikrotik.settings, urls: mikrotik.urls, token: mikrotik.token },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
