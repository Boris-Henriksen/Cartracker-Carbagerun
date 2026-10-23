import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { GREETING_FILE, publicSettings, readSettings, receiveAudio, reloadAsterisk, writeAsteriskConfig, writeSettings } from "@/lib/pbx";

export async function POST(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const result = await receiveAudio(request, GREETING_FILE);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const settings = readSettings();
  settings.menu.greeting = { name: result.name, uploadedAt: new Date().toISOString() };
  writeSettings(settings);
  writeAsteriskConfig(settings);
  return NextResponse.json({ settings: publicSettings(settings), applied: await reloadAsterisk() }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const settings = readSettings();
  settings.menu.greeting = null;
  writeSettings(settings);
  await fs.promises.rm(GREETING_FILE, { force: true });
  writeAsteriskConfig(settings);
  return NextResponse.json({ settings: publicSettings(settings), applied: await reloadAsterisk() });
}
