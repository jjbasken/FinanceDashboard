import { createApp } from "../src/app";
import { openDb } from "../src/db";

export function testApp() {
  const db = openDb(":memory:");
  return { db, app: createApp({ db }) };
}

type App = ReturnType<typeof testApp>["app"];

/** A minimal browser stand-in that keeps the session cookie between requests. */
export class Client {
  cookie: string | null = null;

  constructor(private app: App) {}

  async request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (body !== undefined || method !== "GET") headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.request(path, {
      method,
      headers,
      body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const [pair] = setCookie.split(";");
      const [, value] = (pair ?? "").split("=");
      this.cookie = value ? pair! : null;
    }
    const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, json: json as any, headers: res.headers };
  }

  get(path: string) {
    return this.request("GET", path);
  }

  post(path: string, body?: unknown) {
    return this.request("POST", path, body);
  }
}

export const owner = {
  householdName: "The Baskens",
  displayName: "Jeremy",
  username: "jeremy",
  password: "correct horse battery",
};
