/* Pika Store service worker
   - Dobara kholne par site slow net par bhi jaldi khule (cache se)
   - Naya index.html GitHub par jaate hi user tak pahunche (auto update)
   - Firebase files / fonts ek baar download hoke cache mein rehti hain
   - OneSignal push notifications ka code bhi isi mein hai */
try { importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js'); } catch (err) {}

const STORE_CACHE = 'pika-store-v2';
const MOVIE_CACHE = 'pika-movie-v2';
const MOVIE_ASSETS = ['/pika-movie-manifest.json', '/Pika-Movie.png'];
const ROOT = self.registration.scope;
const ROOT_PATH = new URL(ROOT).pathname;
const PAGE_WAIT_MS = 3500;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const res = await fetch(ROOT, { cache: 'no-cache' });
      if (res && res.ok && !res.redirected) { const c = await caches.open(STORE_CACHE); await c.put(ROOT, res); }
    } catch (err) {}
    try { const m = await caches.open(MOVIE_CACHE); await m.addAll(MOVIE_ASSETS); } catch (err) {}
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.indexOf('pika-store-') === 0 && k !== STORE_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStorePage(url) {
  return url.origin === self.location.origin &&
    (url.pathname === ROOT_PATH || url.pathname === ROOT_PATH + 'index.html');
}

function isStaticFile(url) {
  if (url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0) return true;
  if (url.hostname === 'fonts.gstatic.com') return true;
  if (url.hostname === 'raw.githubusercontent.com' && /\.(ttf|woff2?)$/i.test(url.pathname)) return true;
  return false;
}

async function sha1(buf) {
  const d = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Server se taaza index.html lao (HTTP cache ko bypass karke), cache mein rakho, aur batao ki badla ya nahi */
async function refreshPage(cache) {
  const res = await fetch(ROOT, { cache: 'no-cache' });
  if (!res || !res.ok || res.redirected) throw new Error('bad response');
  const buf = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  let changed = false;
  const old = await cache.match(ROOT);
  if (old) {
    try { changed = (await sha1(await old.arrayBuffer())) !== (await sha1(buf)); } catch (err) { changed = true; }
  }
  await cache.put(ROOT, new Response(buf.slice(0), { status: 200, headers }));
  return { buf, headers, changed };
}

function makeResponse(r) {
  return new Response(r.buf.slice(0), { status: 200, headers: r.headers });
}

async function notifyClients() {
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach((c) => c.postMessage({ type: 'PIKA_UPDATED' }));
}

async function handlePage(e) {
  const cache = await caches.open(STORE_CACHE);
  const cached = await cache.match(ROOT);

  if (!cached) {
    const res = await fetch(ROOT, { cache: 'no-cache' });
    if (res && res.ok && !res.redirected) e.waitUntil(cache.put(ROOT, res.clone()));
    return res;
  }

  const job = refreshPage(cache);
  e.waitUntil(job.catch(() => {}));

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PAGE_WAIT_MS));
  const fresh = await Promise.race([job.then(makeResponse).catch(() => null), timeout]);
  if (fresh) return fresh;

  /* Net slow tha: purana page abhi dikhaya, naya baad mein aaye to user ko bata do */
  e.waitUntil(job.then((r) => (r.changed ? notifyClients() : null)).catch(() => {}));
  return cached;
}

async function cacheFirst(req) {
  const cache = await caches.open(STORE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.status === 200) cache.put(req, res.clone());
  return res;
}

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'CHECK_UPDATE') {
    e.waitUntil((async () => {
      try {
        const cache = await caches.open(STORE_CACHE);
        const r = await refreshPage(cache);
        if (r.changed) await notifyClients();
      } catch (err) {}
    })());
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  if (req.mode === 'navigate' && isStorePage(url)) {
    e.respondWith(handlePage(e).catch(() => caches.match(ROOT).then((r) => r || Response.error())));
    return;
  }

  if (url.origin === self.location.origin) {
    if (MOVIE_ASSETS.indexOf(url.pathname) !== -1) {
      e.respondWith(
        fetch(req)
          .then((res) => { const copy = res.clone(); caches.open(MOVIE_CACHE).then((c) => c.put(req, copy)); return res; })
          .catch(() => caches.match(req))
      );
    }
    return;
  }

  if (isStaticFile(url)) {
    e.respondWith(cacheFirst(req).catch(() => caches.match(req).then((r) => r || Response.error())));
  }
});
