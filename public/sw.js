const V = 'awesome-hub-v9';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  const net = fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; });
  if (u.pathname.startsWith('/api/')) return e.respondWith(net.catch(() => caches.match(r)));
  e.respondWith(caches.match(r).then(hit => { net.catch(() => {}); return hit || net; }));
});
