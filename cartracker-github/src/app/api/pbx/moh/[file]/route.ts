import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { MOH_DIR, MOH_FILE_PATTERN, readSettings, reloadAsterisk, writeAsteriskConfig, writeSettings } from "@/lib/pbx";

type Params = { params: Promise<{ file: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const { file } = await params;
  const settings = readSettings();
  if (!MOH_FILE_PATTERN.test(file) || !settings.moh.some((item) => item.file === file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  settings.moh = settings.moh.filter((item) => item.file !== file);
  writeSettings(settings);
  await fs.promises.rm(path.join(MOH_DIR, file), { force: true });
  writeAsteriskConfig(settings);
  return NextResponse.json({ moh: settings.moh, applied: await reloadAsterisk() });
}
