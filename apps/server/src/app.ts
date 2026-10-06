import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Db } from "./db";
import type { SessionContext } from "./auth/sessions";
import { LoginRateLimiter } from "./auth/rate-limit";
import { authRoutes } from "./routes/auth";
import { accountRoutes } from "./routes/accounts";
import { budgetRoutes } from "./routes/budget";
import { categoryRoutes } from "./routes/categories";
import { householdRoutes } from "./routes/household";
import { importRoutes } from "./routes/import";
import { backupRoutes } from "./routes/backup";
import { eventRoutes } from "./routes/events";
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
  /** Folder for nightly backups, or null when they're off (tests). */
  backupDir?: string | null;
}

export type AppEnv = {
  Variables: {
    db: Db;
    secureCookies: boolean;
    loginLimiter: LoginRateLimiter;
    session: SessionContext | null;
    priceProvider: PriceProvider;
    events: EventHub;
    backupDir: string | null;
  };
};

export function createApp({
  db,
  secureCookies = false,
  priceProvider = yahooProvider(),
  backupDir = null,
}: AppOptions) {
  const loginLimiter = new LoginRateLimiter();
  const events = new EventHub();
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    c.set("db", db);
    c.set("secureCookies", secureCookies);
    c.set("loginLimiter", loginLimiter);
    c.set("priceProvider", priceProvider);
    c.set("events", events);
    c.set("backupDir", backupDir);
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
  app.route("/api/transactions", transactionRoutes);
  app.route("/api/categories", categoryRoutes);
  app.route("/api/payees", payeeRoutes);
  app.route("/api/budget", budgetRoutes);
  app.route("/api/import", importRoutes);
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
