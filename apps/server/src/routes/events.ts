import { getCookie } from "hono/cookie";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../app";
import { validateSession } from "../auth/sessions";
import { actorOf, requireAuth, SESSION_COOKIE } from "../middleware";

/** How often to ping; also how often the session is re-checked. */
export const PING_MS = 25_000;

export const eventRoutes = new Hono<AppEnv>().use(requireAuth).get("/", (c) => {
  const { householdId } = actorOf(c);
  const token = getCookie(c, SESSION_COOKIE) ?? "";
  return streamSSE(c, async (stream) => {
    const unsubscribe = c.var.events.subscribe(householdId, (event) => {
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    });
    stream.onAbort(unsubscribe);
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted && !stream.closed) {
      await stream.sleep(PING_MS);
      // Stop streaming to a session that has since signed out or expired.
      if (!validateSession(c.var.db, token)) break;
      await stream.writeSSE({ event: "ping", data: "" });
    }
    unsubscribe();
  });
});
