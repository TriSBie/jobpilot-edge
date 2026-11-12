// JobPilot service worker: chỉ cache vỏ ứng dụng cùng origin. Không bao giờ đụng /api/* hay origin khác (API ở workers.dev).
// HTML: mạng trước, rớt mạng mới dùng bản cache. Tài nguyên tĩnh: cache trước. Đổi VER để xoá cache cũ.
const VER = "jp-shell-v1";
const SHELL = ["/", "/favicon.svg", "/manifest.webmanifest", "/og.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => { if (r.ok && url.pathname === "/") { const c = r.clone(); caches.open(VER).then(x => x.put("/", c)); } return r; })
      .catch(() => caches.match("/")));
    return;
  }
  if (SHELL.includes(url.pathname)) e.respondWith(caches.match(url.pathname).then(r => r || fetch(req)));
});
