import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { openDb } from "./db";
import { purgeExpiredSessions } from "./auth/sessions";
import { seedOwnerFromEnv } from "./seed";
import { MAX_UPLOAD_BYTES } from "./routes/import";
import { refreshPrices, yahooProvider } from "./services/prices";
import { localDate } from "./util";

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

const priceProvider = yahooProvider();
const app = createApp({ db, secureCookies, priceProvider });

// Keep prices current: shortly after start-up, then every six hours. Each run only fetches days
// we don't have yet, so it's cheap. Set PRICE_REFRESH=off to disable (e.g. with no internet).
if (process.env.PRICE_REFRESH !== "off") {
  const run = async () => {
    try {
      const { updated, errors } = await refreshPrices(db, priceProvider, localDate());
      if (updated || errors.length) {
        console.log(`Price refresh: ${updated} new prices${errors.length ? `, ${errors.length} failed` : ""}.`);
      }
      for (const e of errors) console.warn(`  ${e.symbol}: ${e.message}`);
    } catch (err) {
      console.error("Price refresh failed:", err);
    }
  };
  setTimeout(run, 30_000);
  setInterval(run, 6 * 60 * 60 * 1000);
}

// In production the server also serves the built web app (single container, single port).
if (existsSync(join(webDist, "index.html"))) {
  const assets = serveStatic({ root: webDist });
  const indexHtml = join(webDist, "index.html");
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : assets(c, next)));
  // Client-side routes (e.g. /budget) all get the SPA shell.
  app.get("*", (c, next) =>
    c.req.path.startsWith("/api/")
      ? next()
      : c.body(Bun.file(indexHtml).stream(), 200, { "content-type": "text/html; charset=utf-8" }),
  );
}

console.log(`Finance Dashboard listening on http://localhost:${port} (data: ${dataDir})`);

// Leave room for GnuCash book uploads.
export default { port, fetch: app.fetch, maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024 };
