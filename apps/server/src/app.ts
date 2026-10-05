import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Db } from "./db";
import type { SessionContext } from "./auth/sessions";
import { LoginRateLimiter } from "./auth/rate-limit";
import { authRoutes } from "./routes/auth";
import { householdRoutes } from "./routes/household";
import { requireJsonForMutations, sessionMiddleware } from "./middleware";

export interface AppOptions {
  db: Db;
  /** Set the Secure flag on cookies; enable when served over HTTPS. */
  secureCookies?: boolean;
}

export type AppEnv = {
  Variables: {
    db: Db;
    secureCookies: boolean;
    loginLimiter: LoginRateLimiter;
    session: SessionContext | null;
  };
};

export function createApp({ db, secureCookies = false }: AppOptions) {
  const loginLimiter = new LoginRateLimiter();
  const app = new Hono<AppEnv>();

  app.use("/api/*", async (c, next) => {
    c.set("db", db);
    c.set("secureCookies", secureCookies);
    c.set("loginLimiter", loginLimiter);
    await next();
  });
  app.use("/api/*", requireJsonForMutations);
  app.use("/api/*", sessionMiddleware);

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/auth", authRoutes);
  app.route("/api/household", householdRoutes);

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
