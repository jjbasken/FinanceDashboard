import { createApp } from "../src/app";
import { openDb } from "../src/db";
import type { PriceProvider, PriceQuote } from "../src/services/prices";
import type { SecurityLookup } from "@fd/shared";

/** A price provider with canned quotes, so tests never touch the network. */
export function fakePrices(quotes: Record<string, PriceQuote[]> = {}, names: Record<string, SecurityLookup> = {}) {
  const calls: { symbol: string; from: string; to: string }[] = [];
  const provider: PriceProvider = {
    name: "yahoo",
    async history(symbol, from, to) {
      calls.push({ symbol, from, to });
      if (!(symbol in quotes)) throw new Error(`Unknown symbol ${symbol}`);
      return quotes[symbol]!.filter((q) => q.date >= from && q.date <= to);
    },
    async lookup(symbol) {
      return names[symbol] ?? null;
    },
  };
  return { provider, calls };
}

export function testApp(opts: { priceProvider?: PriceProvider; backupDir?: string; trustProxy?: boolean } = {}) {
  const db = openDb(":memory:");
  return {
    db,
    app: createApp({
      db,
      priceProvider: opts.priceProvider ?? fakePrices().provider,
      backupDir: opts.backupDir,
      trustProxy: opts.trustProxy,
    }),
  };
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

  /** POST raw bytes, as the browser does for file uploads. */
  async upload(path: string, bytes: Uint8Array) {
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.request(path, { method: "POST", headers, body: new Uint8Array(bytes) });
    const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, json: json as any, headers: res.headers };
  }

  get(path: string) {
    return this.request("GET", path);
  }

  post(path: string, body?: unknown) {
    return this.request("POST", path, body);
  }

  patch(path: string, body?: unknown) {
    return this.request("PATCH", path, body);
  }

  delete(path: string) {
    return this.request("DELETE", path);
  }
}

export const owner = {
  householdName: "The Baskens",
  displayName: "Jeremy",
  username: "jeremy",
  password: "correct horse battery",
};
