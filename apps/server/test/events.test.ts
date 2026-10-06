import { expect, test } from "bun:test";
import { createSession } from "../src/auth/sessions";
import { users } from "../src/db/schema";
import { createHousehold } from "../src/services/household";
import { SESSION_COOKIE } from "../src/middleware";
import { Client, owner, testApp } from "./helpers";

/** Open the event stream and collect parsed events until `count` arrive (or time out). */
async function listen(app: ReturnType<typeof testApp>["app"], cookie: string) {
  const res = await app.request("/api/events", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: { event: string; data: string }[] = [];
  async function next(timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const block = buffer.indexOf("\n\n");
      if (block >= 0) {
        const raw = buffer.slice(0, block);
        buffer = buffer.slice(block + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
        const data = /^data: (.*)$/m.exec(raw)?.[1] ?? "";
        events.push({ event, data });
        return { event, data };
      }
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (!chunk || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return null;
  }
  return { next, close: () => reader.cancel() };
}

test("changes are pushed to the household's other sessions, tagged with their origin", async () => {
  const { app, db } = testApp();
  const jeremy = new Client(app);
  await jeremy.post("/api/auth/setup", owner);
  const invite = await jeremy.post("/api/household/invites");
  const sam = new Client(app);
  await sam.post("/api/auth/accept-invite", {
    token: invite.json.token,
    displayName: "Sam",
    username: "sam",
    password: "another good password",
  });

  // Someone in another household must hear nothing.
  const other = createHousehold(db, "Neighbours");
  const user = db
    .insert(users)
    .values({ householdId: other.id, username: "n", displayName: "N", passwordHash: "x", role: "owner" })
    .returning()
    .get();
  const outsider = await listen(app, `${SESSION_COOKIE}=${createSession(db, user.id).token}`);
  expect((await outsider.next())?.event).toBe("ready");

  const stream = await listen(app, sam.cookie!);
  expect((await stream.next())?.event).toBe("ready");

  const res = await app.request("/api/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jeremy.cookie!, "x-client-id": "tab-123" },
    body: JSON.stringify({ name: "Checking", type: "checking" }),
  });
  expect(res.status).toBe(201);
  const event = await stream.next();
  expect(event?.event).toBe("change");
  expect(JSON.parse(event!.data)).toEqual({ type: "change", origin: "tab-123" });

  // Reads, failed writes and previews don't announce anything.
  await jeremy.get("/api/accounts");
  await jeremy.post("/api/accounts", { name: "", type: "checking" });
  expect(await stream.next(300)).toBeNull();
  expect(await outsider.next(300)).toBeNull();
  await stream.close();
  await outsider.close();
});

test("the stream requires a session", async () => {
  const { app } = testApp();
  expect((await app.request("/api/events")).status).toBe(401);
});
