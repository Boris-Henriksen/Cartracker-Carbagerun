import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";
import { MOH_DIR, readSettings, receiveAudio, reloadAsterisk, writeAsteriskConfig, writeSettings } from "@/lib/pbx";

// Raw file body like the gallery upload; converted to Asterisk's preferred WAV format with ffmpeg.
export async function POST(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const file = `${Date.now()}-${randomUUID()}.wav`;
  const result = await receiveAudio(request, path.join(MOH_DIR, file));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const settings = readSettings();
  settings.moh.push({ file, name: result.name, uploadedAt: new Date().toISOString() });
  writeSettings(settings);
  writeAsteriskConfig(settings);
  return NextResponse.json({ moh: settings.moh, applied: await reloadAsterisk() }, { status: 201 });
}
