/* Service worker del visor Vigia.
 * SUBIR CACHE_VERSION EN CADA DEPLOY (junto con el ?v= de index.html), si no los usuarios
 * pueden seguir viendo el shell viejo. Al cambiar, el SW nuevo borra los caches anteriores.
 *  - HTML: network-first (cae a cache si no hay red).
 *  - Estaticos same-origin (css/js/img): cache-first; el ?v= de la URL ya versiona cada archivo.
 *  - Cross-origin (CDN leaflet/supabase-js, fuentes, tiles): no se tocan.
 *  - NUNCA se cachea: supabase.co, sslip.io (WHEP/video), /auth, /storage, firmadas, no-GET.
 */
const CACHE_VERSION = 'vigia-2026-10-13f';
const SHELL = ['./', 'index.html', 'comandos.html', 'config.js', 'app.css', 'app.js',
  'img/vigia-logo-128.png', 'img/vigia-logo-192.png', 'img/vigia-logo.png', 'img/apple-touch-icon.png',
  'img/favicon-32.png', 'img/favicon-64.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE_VERSION);
    // Precache de las URLs versionadas (?v=) que referencia index.html, sin hardcodear el v.
    const urls = new Set(SHELL);
    try {
      const html = await (await fetch('index.html', { cache: 'no-cache' })).text();
      for (const m of html.matchAll(/(?:href|src)="((?:app\.css|app\.js|config\.js)\?[^"]+)"/g)) urls.add(m[1]);
    } catch (_) {}
    await Promise.all([...urls].map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE_VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;
  if (/\/(auth|storage)\//i.test(u.pathname) || u.searchParams.has('token')) return;
  if (req.headers.has('range')) return;

  const isHtml = req.mode === 'navigate' || u.pathname.endsWith('.html') || u.pathname.endsWith('/');
  e.respondWith((async () => {
    const c = await caches.open(CACHE_VERSION);
    if (isHtml) {
      try {
        const r = await fetch(req);
        if (r.ok) c.put(req, r.clone());
        return r;
      } catch (_) {
        return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html')) || Response.error();
      }
    }
    const hit = await c.match(req);
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch (_) {
      return (await c.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});

// ---- Avisos push (Web Push; ver docs/PROTOCOLO-AVISOS.md). Payload: {title, body, url, severity, tag}; sin coordenadas. ----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  const loud = d.severity === 'critica' || d.severity === 'alta';
  e.waitUntil(self.registration.showNotification(String(d.title || 'Casco Inteligente').slice(0, 120), {
    body: String(d.body || '').slice(0, 240),
    tag: String(d.tag || 'casco'),          // mismo evento = misma notificacion (no se duplica; el recordatorio la reemplaza)
    renotify: true,
    requireInteraction: loud,               // critica/alta: queda en pantalla hasta que la toquen
    vibrate: loud ? [300, 150, 300, 150, 600] : [200],
    icon: 'img/vigia-logo-192.png',
    badge: 'img/favicon-64.png',
    data: { url: String(d.url || './') },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    let target = self.registration.scope;
    try {
      const u = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope);
      if (u.origin === self.location.origin) target = u.href;   // solo el propio visor
    } catch (_) {}
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); return; }
    }
    await self.clients.openWindow(target);
  })());
});
