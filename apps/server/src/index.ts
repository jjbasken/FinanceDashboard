import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { openDb } from "./db";
import { purgeExpiredSessions } from "./auth/sessions";
import { seedOwnerFromEnv } from "./seed";

const port = Number(process.env.PORT ?? 3000);
const dataDir = resolve(process.env.DATA_DIR ?? join(import.meta.dir, "../../../data"));
const webDist = resolve(process.env.WEB_DIST ?? join(import.meta.dir, "../../web/dist"));
const secureCookies = process.env.COOKIE_SECURE === "true";

const db = openDb(join(dataDir, "finance.db"));

const seed = await seedOwnerFromEnv(db, process.env);
if (seed.status === "created") {
  console.log(`Seeded household owner "${seed.username}" from SEED_* environment variables.`);
  console.log("You can now remove SEED_OWNER_PASSWORD from your environment; it is only used on an empty database.");
} else if (seed.status === "skipped") {
  console.log(`SEED_* variables ignored: ${seed.reason}.`);
}

purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 6 * 60 * 60 * 1000);

const app = createApp({ db, secureCookies });

// In production the server also serves the built web app (single container, single port).
if (existsSync(join(webDist, "index.html"))) {
  const assets = serveStatic({ root: webDist });
  const indexHtml = join(webDist, "index.html");
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : assets(c, next)));
  // Client-side routes (e.g. /budget) all get the SPA shell.
  app.get("*", (c, next) =>
    c.req.path.startsWith("/api/") ? next() : c.body(Bun.file(indexHtml).stream(), 200, { "content-type": "text/html; charset=utf-8" }),
  );
}

console.log(`Finance Dashboard listening on http://localhost:${port} (data: ${dataDir})`);

export default { port, fetch: app.fetch };
