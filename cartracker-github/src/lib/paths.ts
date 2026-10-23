import path from "node:path";

// Installs point this at e.g. /var/lib/cartracker; development falls back to ./data.
export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
