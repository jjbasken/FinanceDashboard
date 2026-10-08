import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { Db } from "./db";
import type { SessionContext } from "./auth/sessions";
import { LoginRateLimiter } from "./auth/rate-limit";
import { PasswordWorkLimiter } from "./auth/password-work";
import { authRoutes } from "./routes/auth";
import { accountRoutes } from "./routes/accounts";
import { budgetRoutes } from "./routes/budget";
import { categoryRoutes } from "./routes/categories";
import { householdRoutes } from "./routes/household";
import { createImportRoutes } from "./routes/import";
import { backupRoutes } from "./routes/backup";
import { eventRoutes } from "./routes/events";
import { folderRoutes } from "./routes/folders";
import { reportRoutes } from "./routes/reports";
import { investmentRoutes } from "./routes/investments";
import { EventHub } from "./services/events";
import { type PriceProvider, yahooProvider } from "./services/prices";
import { payeeRoutes } from "./routes/payees";
import { transactionRoutes } from "./routes/transactions";
import { requireJsonForMutations, sessionMiddleware } from "./middleware";

export interface AppOptions {
  db: Db;
  /** Set the Secure flag on cookies; enable when served over HTTPS. */
  secureCookies?: boolean;
  /** Where daily prices come from (Yahoo by default). */
  priceProvider?: PriceProvider;
  /** Folder containing backups, or null when unavailable (tests). */
  backupDir?: string | null;
  /** Whether the nightly scheduler is running; the directory can still contain older copies. */
  backupsEnabled?: boolean;
  /** Trust X-Forwarded-For for the client's address (only behind a reverse proxy you run). */
  trustProxy?: boolean;
}

export type AppEnv = {
  Variables: {
    db: Db;
    secureCookies: boolean;
    loginLimiter: LoginRateLimiter;
    passwordWork: PasswordWorkLimiter;
    session: SessionContext | null;
    priceProvider: PriceProvider;
    events: EventHub;
    backupDir: string | null;
    backupsEnabled: boolean;
    trustProxy: boolean;
  };
};

export function createApp({
  db,
  secureCookies = false,
  priceProvider = yahooProvider(),
  backupDir = null,
  backupsEnabled = !!backupDir,
  trustProxy = false,
}: AppOptions) {
  const loginLimiter = new LoginRateLimiter();
  const passwordWork = new PasswordWorkLimiter();
  const events = new EventHub();
  const app = new Hono<AppEnv>();

  // Defence in depth for the API and the web app it serves: no framing, no inline scripts, no
  // content sniffing, and no referrer leaking out. HSTS only when served over HTTPS.
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React and the charts set style attributes.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      strictTransportSecurity: secureCookies ? "max-age=15552000" : false,
      // Browsers ignore (and warn about) these on plain-HTTP origins other than localhost.
      crossOriginOpenerPolicy: secureCookies,
      originAgentCluster: secureCookies,
      referrerPolicy: "no-referrer",
    }),
  );

  app.use("/api/*", async (c, next) => {
    // Financial data and authentication responses must not be cached by browsers or proxies.
    c.header("Cache-Control", "no-store");
    c.set("db", db);
    c.set("secureCookies", secureCookies);
    c.set("loginLimiter", loginLimiter);
    c.set("passwordWork", passwordWork);
    c.set("priceProvider", priceProvider);
    c.set("events", events);
    c.set("backupDir", backupDir);
    c.set("backupsEnabled", backupsEnabled);
    c.set("trustProxy", trustProxy);
    await next();
  });
  app.use("/api/*", requireJsonForMutations);
  app.use("/api/*", sessionMiddleware);
  // Tell the household's other open sessions that something changed, so they refetch.
  app.use("/api/*", async (c, next) => {
    await next();
    const s = c.var.session;
    if (!s || c.req.method === "GET" || c.res.status >= 400) return;
    if (c.req.path.startsWith("/api/auth/") || c.req.path.endsWith("/preview")) return;
    events.publish(s.household.id, { type: "change", origin: c.req.header("x-client-id")?.slice(0, 64) ?? null });
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", authRoutes);
  app.route("/api/household", householdRoutes);
  app.route("/api/accounts", accountRoutes);
  app.route("/api/account-folders", folderRoutes);
  app.route("/api/transactions", transactionRoutes);
  app.route("/api/categories", categoryRoutes);
  app.route("/api/payees", payeeRoutes);
  app.route("/api/budget", budgetRoutes);
  app.route("/api/import", createImportRoutes());
  app.route("/api/investments", investmentRoutes);
  app.route("/api/events", eventRoutes);
  app.route("/api/backup", backupRoutes);
  app.route("/api/reports", reportRoutes);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
