import { NextRequest, NextResponse } from "next/server";
import { unlockSetup } from "@/lib/setup";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const error = await unlockSetup(typeof body?.code === "string" ? body.code : "", request);
  if (error) return NextResponse.json({ error }, { status: 403 });
  return NextResponse.json({ ok: true });
}
