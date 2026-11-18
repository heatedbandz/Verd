// Verd's service worker: the app opens with no connection, and keeps itself up to date.
// The page, its code and its icons live in one cache. Opening Verd is served from that cache straight away;
// then the newest page and code are fetched in the background and, if anything changed, swapped in together,
// so the next launch is the new version. Nothing here needs a version number bumped by hand.
// Requests to other sites (the database) are never touched: an answer made offline waits in the app's outbox.
const CACHE = "verd-shell";
const CODE = ["./", "app.js", "core.js"];
const SHELL = [...CODE, "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const SCOPE = new URL("./", location).pathname;

// Downloads everything first and only then replaces the cache, so it never holds half of one version.
async function fetchAll(urls){
  const got = await Promise.all(urls.map(u => fetch(u, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(u + " " + r.status); return r; })));
  const c = await caches.open(CACHE);
  await Promise.all(got.map((r, i) => c.put(urls[i], r)));
}

self.addEventListener("install", e => e.waitUntil(fetchAll(SHELL).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

// After a launch: has the page or its code changed since it was cached? Then fetch the whole shell again.
async function refresh(){
  try{
    const c = await caches.open(CACHE);
    const changed = await Promise.all(CODE.map(async u => {
      const [now, had] = await Promise.all([fetch(u, { cache: "no-cache" }), c.match(u)]);
      return now.ok && (!had || await now.text() !== await had.text());
    }));
    if (changed.some(Boolean)) await fetchAll(SHELL);
  }catch(e){ /* offline: try again next launch */ }
}

self.addEventListener("fetch", e => {
  const r = e.request, url = new URL(r.url);
  if (r.method !== "GET" || url.origin !== location.origin) return;
  if (r.mode === "navigate"){
    // Only the app itself. Other pages on the site (the README, the plan) go to the network as usual.
    if (url.pathname !== SCOPE && url.pathname !== SCOPE + "index.html") return;
    e.respondWith(caches.match("./", { ignoreSearch: true, ignoreVary: true }).then(hit => hit || fetch(r)));
    e.waitUntil(refresh());
    return;
  }
  e.respondWith(caches.match(r, { ignoreVary: true }).then(hit => hit || fetch(r)));
});
