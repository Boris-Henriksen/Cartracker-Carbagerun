import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { CONTENT_TYPE_BY_EXT, MEDIA_DIR, MEDIA_FILE_PATTERN, removeMedia } from "@/lib/media";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";

type Params = { params: Promise<{ file: string }> };

// Range support is needed for video seeking, and Safari won't play video without it.
export async function GET(request: NextRequest, { params }: Params) {
  const { file } = await params;
  if (!MEDIA_FILE_PATTERN.test(file)) return new NextResponse(null, { status: 404 });

  const target = path.join(MEDIA_DIR, file);
  let size: number;
  try {
    size = (await fs.promises.stat(target)).size;
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  const headers = new Headers({
    "Content-Type": CONTENT_TYPE_BY_EXT[path.extname(file).slice(1)],
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400",
  });

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (!match || start > end || start >= size) {
      headers.set("Content-Range", `bytes */${size}`);
      return new NextResponse(null, { status: 416, headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }

  headers.set("Content-Length", String(end - start + 1));
  const stream = Readable.toWeb(fs.createReadStream(target, { start, end })) as ReadableStream;
  return new NextResponse(stream, { status, headers });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const { file } = await params;
  if (!MEDIA_FILE_PATTERN.test(file) || !removeMedia(file)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
