/* נוני — Service Worker מינימלי: נדרש להתקנה כאפליקציה (PWA). רשת קודם; בלי אופליין אמיתי,
   רק דף נחיתה קטן כשאין רשת. API לעולם לא נשמר במטמון. */
const V = "noni-sw-2026-11-02-03";
const SHELL = ["./", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/apple-touch-icon.png"];
const OFFLINE = "<!doctype html><html lang=he dir=rtl><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>נוני · אין חיבור</title><body style='font-family:Heebo,Arial,sans-serif;background:#0b0a0e;color:#f3f1f6;text-align:center;padding:40px'><h2>אין חיבור לאינטרנט</h2><p>נוני תחזור ברגע שיש רשת.</p><button onclick='location.reload()' style='margin-top:12px;background:#ff2d9a;color:#fff;border:0;border-radius:999px;padding:10px 22px;font:inherit;cursor:pointer'>לנסות שוב</button></body></html>";
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  // רק בקשות GET מאותו מקור; API ומשאבים חיצוניים (גופנים, Google) עוברים ישר לרשת
  if (req.method !== "GET" || u.origin !== self.location.origin || u.pathname.startsWith("/api/")) return;
  const nav = req.mode === "navigate";
  const cacheable = nav ? (/\/(index\.html)?$/.test(u.pathname)) : /\.(png|svg|webmanifest)$/.test(u.pathname);
  e.respondWith(fetch(req).then(r => {
    if (r.ok && cacheable) { const c = r.clone(); caches.open(V).then(x => x.put(nav ? "./" : req, c)).catch(() => {}); }
    return r;
  }).catch(async () => {
    const m = await caches.match(nav && cacheable ? "./" : req, { ignoreSearch: true });
    if (m) return m;
    if (nav) return new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    return Response.error();
  }));
});
