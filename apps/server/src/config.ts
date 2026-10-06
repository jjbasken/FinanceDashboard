import { join, resolve } from "node:path";

/** Folder holding finance.db and backups/. Docker uses /data; local dev uses data/ at the repo root. */
export const dataDir = resolve(process.env.DATA_DIR ?? join(import.meta.dir, "../../../data"));
