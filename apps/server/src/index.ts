import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "hono/bun";
import { createApp } from "./app";
import { dataDir } from "./config";
import { openDb } from "./db";
import { purgeExpiredSessions } from "./auth/sessions";
import { seedOwnerFromEnv } from "./seed";
import { MAX_UPLOAD_BYTES } from "./routes/import";
import { runNightlyBackup } from "./services/backup";
import { EventHub } from "./services/events";
import { createLogger, errorDetails, pruneLogs } from "./services/log";
import { postScheduledBills } from "./services/scheduled-bills";
import { refreshPrices, yahooProvider } from "./services/prices";
import { localDate } from "./util";

const port = Number(process.env.PORT ?? 3000);
const webDist = resolve(process.env.WEB_DIST ?? join(import.meta.dir, "../../web/dist"));
const secureCookies = process.env.COOKIE_SECURE === "true";

let migrations: string[] = [];
const db = openDb(join(dataDir, "finance.db"), (applied) => (migrations = applied));
const log = createLogger(db, { console: true });
const version = process.env.GIT_COMMIT || "unknown";
log.info("server", `Started version ${version}`, {
  details: { version, migrationsApplied: migrations, dataDir, timeZone: process.env.TZ || "UTC" },
});
if (migrations.length) log.info("server", `Applied database migrations: ${migrations.join(", ")}`);

const seed = await seedOwnerFromEnv(db, process.env);
if (seed.status === "created") {
  log.info("server", `Seeded household owner "${seed.username}" from SEED_* environment variables`);
  console.log("You can now remove SEED_OWNER_PASSWORD from your environment; it is only used on an empty database.");
} else if (seed.status === "skipped") {
  console.log(`SEED_* variables ignored: ${seed.reason}.`);
}

purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 6 * 60 * 60 * 1000);

const priceProvider = yahooProvider();
const backupDir = join(dataDir, "backups");
const trustProxy = process.env.TRUST_PROXY === "true";
const keepBackups = Number(process.env.BACKUP_KEEP ?? 14);
const events = new EventHub();
const app = createApp({
  db,
  secureCookies,
  priceProvider,
  backupDir,
  backupsEnabled: keepBackups > 0,
  trustProxy,
  events,
  logger: log,
});

// Recurring bills: on the 1st (checked hourly, and at start-up in case the server was down), post
// each bill's occurrences for the new month, then refresh the household's open sessions.
// The same hourly job prunes log entries older than 90 days.
const hourly = () => {
  try {
    for (const householdId of postScheduledBills(db, localDate(), log)) {
      events.publish(householdId, { type: "change", origin: null });
    }
  } catch (err) {
    log.error("bills", "Posting recurring bills failed", { details: errorDetails(err) });
  }
  try {
    pruneLogs(db);
  } catch (err) {
    log.error("server", "Pruning old log entries failed", { details: errorDetails(err) });
  }
};
hourly();
setInterval(hourly, 60 * 60 * 1000);

// Nightly backups: check hourly and make today's copy if it's missing, keeping the newest
// BACKUP_KEEP (default 14). Set BACKUP_KEEP=0 to turn them off.
if (keepBackups > 0) {
  const backup = () => {
    try {
      const { name, created, removed } = runNightlyBackup(db, backupDir, localDate(), keepBackups);
      if (created) log.info("backup", `Backed up the database to ${join(backupDir, name)}`);
      if (removed.length) log.info("backup", `Removed old backups: ${removed.join(", ")}`);
    } catch (err) {
      log.error("backup", `Backup failed: ${err instanceof Error ? err.message : String(err)}`, {
        details: errorDetails(err),
      });
    }
  };
  backup();
  setInterval(backup, 60 * 60 * 1000);
}

// Keep prices current: shortly after start-up, then every six hours. Each run only fetches days
// we don't have yet, so it's cheap. Set PRICE_REFRESH=off to disable (e.g. with no internet).
if (process.env.PRICE_REFRESH !== "off") {
  const run = async () => {
    try {
      await refreshPrices(db, priceProvider, localDate(), undefined, log);
    } catch (err) {
      log.error("prices", `Price refresh failed: ${err instanceof Error ? err.message : String(err)}`, {
        details: errorDetails(err),
      });
    }
  };
  setTimeout(run, 30_000);
  setInterval(run, 6 * 60 * 60 * 1000);
}

// In production the server also serves the built web app (single container, single port).
if (existsSync(join(webDist, "index.html"))) {
  const assets = serveStatic({ root: webDist });
  const indexHtml = join(webDist, "index.html");
  // The service worker and app manifest must be re-checked on every load so app updates reach installed copies.
  app.get("/sw.js", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });
  app.get("/manifest.webmanifest", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
    c.header("Content-Type", "application/manifest+json");
  });
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : assets(c, next)));
  // Client-side routes (e.g. /budget) all get the SPA shell.
  app.get("*", (c, next) =>
    c.req.path.startsWith("/api/")
      ? next()
      : c.body(Bun.file(indexHtml).stream(), 200, { "content-type": "text/html; charset=utf-8" }),
  );
}

console.log(`Finance Dashboard listening on http://localhost:${port} (data: ${dataDir})`);

// Leave room for GnuCash book uploads, and keep live-update streams (pinged every 25s) open.
// development: false keeps Bun from ever serving its detailed error pages, even when NODE_ENV isn't set.
export default {
  port,
  fetch: app.fetch,
  maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
  idleTimeout: 60,
  development: false,
};
