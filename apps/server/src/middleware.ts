import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { AppEnv } from "./app";
import { SESSION_TTL_MS, validateSession } from "./auth/sessions";

export const SESSION_COOKIE = "fd_session";

/**
 * CSRF defence: browsers can't send cross-site application/json (or application/octet-stream)
 * requests without a CORS preflight, which we never grant. So every mutation must use one of
 * those; octet-stream is for file uploads.
 */
export const requireJsonForMutations = createMiddleware<AppEnv>(async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/json") && !type.startsWith("application/octet-stream")) {
      throw new HTTPException(415, { message: "Expected application/json" });
    }
  }
  await next();
});

export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set("session", null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const result = validateSession(c.var.db, token);
    if (result) {
      c.set("session", result.ctx);
      if (result.renewed) setSessionCookie(c, token, result.expiresAt);
    } else {
      clearSessionCookie(c);
    }
  }
  await next();
});

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.session) throw new HTTPException(401, { message: "Not signed in" });
  await next();
});

export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.session?.user.role !== "owner") {
    throw new HTTPException(403, { message: "Only the household owner can do that" });
  }
  await next();
});

/** Get the session inside a route that sits behind requireAuth. */
export function sessionOf(c: Context<AppEnv>) {
  const s = c.var.session;
  if (!s) throw new HTTPException(401, { message: "Not signed in" });
  return s;
}

export function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: number) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.var.secureCookies,
    path: "/",
    expires: new Date(expiresAt),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: c.var.secureCookies });
}

/** Parse a JSON body with a zod schema, returning 400 with field errors on failure. */
export async function parseBody<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.join(".");
    throw new HTTPException(400, {
      message: first ? (field ? `${field}: ${first.message}` : first.message) : "Invalid input",
    });
  }
  return result.data;
}

/**
 * The client's address, for rate limiting. Behind a trusted reverse proxy it's the last address
 * in X-Forwarded-For (the one the proxy itself saw); otherwise the connection's address.
 */
export function clientAddress(c: Context<AppEnv>) {
  if (c.var.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // No socket (e.g. in tests).
    return "unknown";
  }
}

/** Parse a positive integer route parameter, 404ing on anything else. */
export function idParam(c: Context<AppEnv>, name = "id") {
  const raw = c.req.param(name) ?? "";
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  if (id <= 0) throw new HTTPException(404, { message: "Not found" });
  return id;
}

/** The household and user behind the current request, for scoping ledger queries. */
export function actorOf(c: Context<AppEnv>) {
  const { user, household } = sessionOf(c);
  return { householdId: household.id, userId: user.id };
}
