import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NextRequest, NextResponse } from "next/server";
import {
  MAX_UPLOAD_BYTES,
  MEDIA_DIR,
  MEDIA_TYPES,
  addMedia,
  listMedia,
  matchesSignature,
  type MediaItem,
} from "@/lib/media";
import { adminAuthError, checkAdminCode } from "@/lib/admin-auth";

export async function GET() {
  return NextResponse.json({ items: listMedia() });
}

// The raw file is the request body (no multipart), so large videos stream straight to disk.
export async function POST(request: NextRequest) {
  const auth = await checkAdminCode(request);
  if (auth.status !== "ok") return adminAuthError(auth);

  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const mediaType = MEDIA_TYPES[type];
  if (!mediaType) return NextResponse.json({ error: "Only JPG, PNG, WebP, GIF, MP4, MOV and WebM files are allowed" }, { status: 415 });

  if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is larger than 100 MB" }, { status: 413 });
  }
  if (!request.body) return NextResponse.json({ error: "Empty upload" }, { status: 400 });

  let name = "upload";
  try {
    name = decodeURIComponent(request.headers.get("x-file-name") ?? "").slice(0, 200) || name;
  } catch {
    // Keep the default name for malformed encodings.
  }

  const file = `${Date.now()}-${randomUUID()}.${mediaType.ext}`;
  const target = path.join(MEDIA_DIR, file);
  await fs.promises.mkdir(MEDIA_DIR, { recursive: true });

  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_UPLOAD_BYTES ? new Error("too large") : null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(request.body as unknown as NodeReadableStream), limiter, fs.createWriteStream(target));
  } catch {
    await fs.promises.rm(target, { force: true });
    const tooLarge = size > MAX_UPLOAD_BYTES;
    return NextResponse.json({ error: tooLarge ? "File is larger than 100 MB" : "Upload was interrupted" }, { status: tooLarge ? 413 : 400 });
  }

  const handle = await fs.promises.open(target, "r");
  const head = Buffer.alloc(16);
  await handle.read(head, 0, 16, 0);
  await handle.close();
  if (size === 0 || !matchesSignature(mediaType.ext, head)) {
    await fs.promises.rm(target, { force: true });
    return NextResponse.json({ error: "File content doesn't match its type" }, { status: 415 });
  }

  const item: MediaItem = { file, name, type, kind: mediaType.kind, size, uploadedAt: new Date().toISOString() };
  addMedia(item);
  return NextResponse.json({ item }, { status: 201 });
}
