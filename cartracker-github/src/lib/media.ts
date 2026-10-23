import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/paths";

export const MEDIA_DIR = path.join(DATA_DIR, "media");
const INDEX_FILE = path.join(DATA_DIR, "media.json");

// Cloudflare Tunnel (free plan) rejects request bodies above 100 MB.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type MediaKind = "image" | "video";

// SVG and HEIC are deliberately excluded: SVG can carry scripts, HEIC doesn't render outside Safari.
export const MEDIA_TYPES: Record<string, { ext: string; kind: MediaKind }> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
};

export const CONTENT_TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([type, { ext }]) => [ext, type])
);

export const MEDIA_FILE_PATTERN = /^\d+-[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|mov|webm)$/;

export type MediaItem = {
  file: string;
  name: string;
  type: string;
  kind: MediaKind;
  size: number;
  uploadedAt: string;
};

function readIndex(): MediaItem[] {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")) as MediaItem[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function writeIndex(items: MediaItem[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(items));
  fs.renameSync(tempFile, INDEX_FILE);
}

export function listMedia(): MediaItem[] {
  return readIndex().sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

export function addMedia(item: MediaItem) {
  writeIndex([...readIndex(), item]);
}

export function removeMedia(file: string): boolean {
  const items = readIndex();
  const remaining = items.filter((item) => item.file !== file);
  if (remaining.length === items.length) return false;
  writeIndex(remaining);
  fs.rmSync(path.join(MEDIA_DIR, file), { force: true });
  return true;
}

// Verify the file content matches its declared type, so e.g. HTML can't be uploaded as "image/png".
export function matchesSignature(ext: string, head: Buffer): boolean {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  switch (ext) {
    case "jpg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "png":
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "gif":
      return ascii(0, 4) === "GIF8";
    case "webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "webm":
      return head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case "mp4":
      return ascii(4, 8) === "ftyp";
    case "mov":
      return ["ftyp", "moov", "wide", "mdat", "free"].includes(ascii(4, 8));
    default:
      return false;
  }
}
