// Family Finance service worker. It makes the app installable and lets it open quickly (and show its
// "can't reach the server" screen instead of a browser error when offline).
//
// It never touches /api/: financial data and sign-in always go to the server and are never cached.
// Built files under /assets/ have content hashes in their names, so they're served from the cache
// once fetched. Pages always try the network first and fall back to the last good copy of the app.

const CACHE = "fd-shell-v1";
const SHELL = "/index.html";
const MAX_ASSETS = 60;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(page(req));
  } else if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(req));
  }
});

async function page(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Only keep the app itself, not e.g. a sign-in page from a proxy in front of it.
    const html = res.headers.get("content-type")?.includes("text/html");
    if (res.ok && !res.redirected && res.type === "basic" && html) await cache.put(SHELL, res.clone());
    return res;
  } catch (err) {
    const shell = await cache.match(SHELL);
    if (shell) return shell;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    await cache.put(req, res.clone());
    await trim(cache);
  }
  return res;
}

/** Drop the oldest files once old builds pile up. */
async function trim(cache) {
  const keys = (await cache.keys()).filter((k) => new URL(k.url).pathname !== SHELL);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}
