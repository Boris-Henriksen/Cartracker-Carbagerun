import { NextRequest, NextResponse } from "next/server";
import { changeAdminCode, updateSecuritySettings } from "@/lib/admin-auth";
import { amiCredentials, applyUpdate, asteriskStatus, publicSettings, readSettings, reloadAsterisk, writeAsteriskConfig, writeSettings } from "@/lib/pbx";
import { mikrotikState } from "@/lib/mikrotik-state";
import { requestOrigin } from "@/lib/server-info";
import { completeSetup, hasSetupSession } from "@/lib/setup";
import { markMikrotikInstalled, updateSiteSettings } from "@/lib/site-settings";
import { regenerateVehicleToken, vehicleToken } from "@/lib/vehicle-token";

type PhoneStep = {
  mode: "local" | "public";
  extension: string;
  password: string;
  testEnabled: boolean;
  testExtension: string;
  testPassword: string;
  externalAddress: string;
  trunk: { enabled: boolean; host: string; port: number; username: string; password: string; number: string };
};

function applyPhone(data: PhoneStep): string | null {
  const current = readSettings();
  const shown = publicSettings(current);
  const result = applyUpdate(current, {
    ...shown,
    mode: data.mode,
    phone: { extension: data.extension, password: data.password },
    test: { enabled: data.mode === "local" && data.testEnabled, extension: data.testExtension, password: data.testPassword },
    network: { externalAddress: data.mode === "public" ? data.externalAddress : "" },
    trunk: data.mode === "public" ? data.trunk : shown.trunk,
  });
  if ("error" in result) return result.error;
  writeSettings(result.settings);
  writeAsteriskConfig(result.settings);
  return null;
}

/** One setup step per request, so the wizard can show real progress and retry a single failing step. */
export async function POST(request: NextRequest) {
  if (!(await hasSetupSession())) return NextResponse.json({ error: "Setup session expired. Reload the page and enter the setup code again." }, { status: 401 });

  const { step, data } = (await request.json().catch(() => ({}))) as { step?: string; data?: Record<string, unknown> };
  const fail = (error: string) => NextResponse.json({ error }, { status: 400 });

  switch (step) {
    case "admin": {
      const error = changeAdminCode(data?.code);
      return error ? fail(error) : NextResponse.json({ ok: true });
    }
    case "site":
    case "tracking": {
      const result = updateSiteSettings(data);
      return "error" in result ? fail(result.error) : NextResponse.json({ ok: true });
    }
    case "mikrotik": {
      const result = updateSiteSettings({ mikrotik: data });
      if ("error" in result) return fail(result.error);
      if (data?.installed === true) markMikrotikInstalled(mikrotikState(requestOrigin(request)).fingerprint);
      return NextResponse.json({ ok: true });
    }
    case "token": {
      regenerateVehicleToken();
      const state = mikrotikState(requestOrigin(request));
      return NextResponse.json({ ok: true, token: state.token });
    }
    case "phone": {
      const error = applyPhone(data as unknown as PhoneStep);
      if (error) return fail(error);
      const reload = await reloadAsterisk();
      return reload.ok ? NextResponse.json({ ok: true }) : fail(`Settings saved, but Asterisk didn't load them: ${reload.error}`);
    }
    case "security": {
      const result = updateSecuritySettings(data);
      return "error" in result ? fail(result.error) : NextResponse.json({ ok: true });
    }
    case "check": {
      const problems: string[] = [];
      if (!vehicleToken()) problems.push("No vehicle token is set.");
      if (amiCredentials()) {
        const status = await asteriskStatus();
        if (!status.connected) problems.push(`Phone system: ${status.error}`);
      }
      return problems.length ? fail(problems.join(" ")) : NextResponse.json({ ok: true });
    }
    case "finish":
      await completeSetup();
      return NextResponse.json({ ok: true });
    default:
      return fail("Unknown setup step");
  }
}
