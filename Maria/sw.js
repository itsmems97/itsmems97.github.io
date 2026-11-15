/* Pika Store service worker (v3 - image cache upgrade)
   - Dobara kholne par site slow net par bhi jaldi khule (cache se)
   - Naya index.html GitHub par jaate hi user tak pahunche (auto update)
   - Firebase files / fonts ek baar download hoke cache mein rehti hain
   - NEW: Chhoti images (PNG/JPG/WEBP/icons/logos/emojis/thumbnails) phone mein save
          hoti hain aur agli baar turant (0 data) cache se khulti hain
   - NEW: APK / ZIP / RAR / video aur 10MB se badi files kabhi cache nahi hoti
   - NEW: Image GitHub ya server par badli to apne aap update ho jaati hai
          (file ka naam ya version number badalne ki zarurat nahi)
   - OneSignal push notifications ka code bhi isi mein hai */
try { importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js'); } catch (err) {}

/* ================== SETTINGS (yahan se sab control hota hai) ================== */
const STORE_CACHE = 'pika-store-v2';
const MOVIE_CACHE = 'pika-movie-v2';
const IMG_CACHE = 'pika-img-v1';          // sirf tab badlo jab saari images zabardasti dobara download karwani ho

const MOVIE_ASSETS = ['/pika-movie-manifest.json', '/Pika-Movie.png'];

/* Kin websites ki images cache hongi + kitni der baad background mein check hoga ki image badli ya nahi */
const HOUR = 60 * 60 * 1000;
const IMAGE_HOSTS = {
  'raw.githubusercontent.com': 1 * HOUR,   // GitHub ki icons / logos / emojis / avatars
  'itsmems97.github.io': 1 * HOUR,         // tumhari apni site ki images
  '193-122-76-131.nip.io': 24 * HOUR       // Oracle server: screenshots / thumbnails (naam har upload ka alag hota hai)
};
const DEFAULT_RECHECK_MS = 6 * HOUR;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // 10MB se badi file kabhi cache nahi hogi
const MAX_IMAGE_ENTRIES = 600;             // itni images ke baad sabse purani apne aap hat jaati hain
const MAX_PARALLEL_CHECKS = 4;             // background update-check ek saath kitne

/* Ye files kabhi cache nahi hongi (download wali / badi files) */
const BLOCKED_EXT = /\.(apk|apks|xapk|aab|zip|rar|7z|tar|gz|tgz|iso|exe|msi|dmg|bin|mp4|mkv|mov|avi|webm|mp3|wav|m4a|pdf)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|ico|avif|bmp)$/i;
/* Jin image URLs mein ye time-wale parameter hon (?_t=123), unhe cache nahi karte (app ne khud fresh maanga hai) */
const BUSTER_PARAM = /[?&](_t|ts|cb|cachebust|nocache|pks)=/i;

/* Install ke time hi ye images phone mein save kar lo (sabse zaruri logo) */
const PRECACHE_IMAGES = [
  'https://raw.githubusercontent.com/itsmems97/itsmems97.github.io/refs/heads/main/pika.png'
];
/* ============================================================================= */

const ROOT = self.registration.scope;
const ROOT_PATH = new URL(ROOT).pathname;
const PAGE_WAIT_MS = 3500;

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp'
};

const corsBlockedHosts = new Set();   // jin hosts par CORS band mila (cache nahi ho sakti)
const checking = new Set();           // jin URLs ka update-check chal raha hai
let activeChecks = 0;
const waitingChecks = [];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    try {
      const res = await fetch(ROOT, { cache: 'no-cache' });
      if (res && res.ok && !res.redirected) { const c = await caches.open(STORE_CACHE); await c.put(ROOT, res); }
    } catch (err) {}
    try { const m = await caches.open(MOVIE_CACHE); await m.addAll(MOVIE_ASSETS); } catch (err) {}
    try {
      const imgs = await caches.open(IMG_CACHE);
      await Promise.all(PRECACHE_IMAGES.map(async (u) => {
        try {
          if (await imgs.match(u, { ignoreVary: true })) return;
          const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
          if (r && r.ok) await storeImage(imgs, u, r);
        } catch (err) {}
      }));
    } catch (err) {}
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

/* ======================= PAGE (index.html) — pehle jaisa hi ======================= */

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

/* ======================= IMAGES — cache first + auto update ======================= */

function recheckMsFor(url) {
  return IMAGE_HOSTS[url.hostname] || DEFAULT_RECHECK_MS;
}

/* Kya ye request ek chhoti image hai jise cache karna hai? */
function isCacheableImage(url, req) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !Object.prototype.hasOwnProperty.call(IMAGE_HOSTS, url.hostname)) return false;
  if (BLOCKED_EXT.test(url.pathname)) return false;
  if (BUSTER_PARAM.test(url.search)) return false;
  return req.destination === 'image' || IMAGE_EXT.test(url.pathname);
}

/* Response ka content-type dekho; image nahi hai to null (cache nahi karenge) */
function imageType(res, url) {
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct.indexOf('image/') === 0) return ct;
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
    const m = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname);
    if (m && MIME_BY_EXT[m[1].toLowerCase()]) return MIME_BY_EXT[m[1].toLowerCase()];
  }
  return null;
}

/* Body padho, par MAX_IMAGE_BYTES se badi nikli to ruk jao (null) */
async function readLimited(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (len && len > max) return null;
  if (!res.body || !res.body.getReader) {
    const b = await res.arrayBuffer();
    return b.byteLength > max ? null : b;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    total += r.value.byteLength;
    if (total > max) { try { reader.cancel(); } catch (err) {} return null; }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

/* Sabse purani images hatao jab limit se zyada ho jayein */
async function trimImages(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_IMAGE_ENTRIES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

/* Image ko cache mein rakho (size/type check ke saath). true = save hui */
async function storeImage(cache, url, res) {
  if (!res || !res.ok || res.status !== 200) return false;
  const type = imageType(res, url);
  if (!type) return false;
  const buf = await readLimited(res, MAX_IMAGE_BYTES);
  if (!buf) return false;
  const hash = await sha1(buf);
  const headers = new Headers({
    'content-type': type,
    'x-pika-cached-at': String(Date.now()),
    'x-pika-hash': hash
  });
  await cache.put(url, new Response(buf, { status: 200, statusText: 'OK', headers }));
  await trimImages(cache);
  return true;
}

function runLimited(task) {
  return new Promise((resolve) => {
    const run = () => {
      activeChecks++;
      task().catch(() => {}).then(() => {
        activeChecks--;
        resolve();
        const next = waitingChecks.shift();
        if (next) next();
      });
    };
    if (activeChecks < MAX_PARALLEL_CHECKS) run(); else waitingChecks.push(run);
  });
}

/* Background mein check: server par image badli? Badli to cache mein naya version, hati to cache se delete.
   cache:'no-cache' = browser sirf pooch-ta hai "kuch badla?" — na badli ho to (almost) 0 data lagta hai */
async function recheckImage(url) {
  if (checking.has(url)) return;
  checking.add(url);
  try {
    const cache = await caches.open(IMG_CACHE);
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-cache' });
    if (res.status === 404 || res.status === 410) { await cache.delete(url); return; }
    if (!res.ok) return;
    await storeImage(cache, url, res);
  } catch (err) {
  } finally {
    checking.delete(url);
  }
}

async function handleImage(e, req, url) {
  const cache = await caches.open(IMG_CACHE);
  const key = url.href;
  const hit = await cache.match(key, { ignoreVary: true });

  if (hit) {
    const age = Date.now() - Number(hit.headers.get('x-pika-cached-at') || 0);
    if (!(age >= 0 && age < recheckMsFor(url))) e.waitUntil(runLimited(() => recheckImage(key)));
    return hit;
  }

  if (corsBlockedHosts.has(url.hostname)) return fetch(req);

  let res;
  try {
    res = await fetch(key, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    /* CORS band hai ya net nahi hai — pehle jaisa normal tarike se try karo */
    const plain = await fetch(req);
    if (plain) {
      corsBlockedHosts.add(url.hostname);
      try { console.warn('[Pika SW] CORS band hai, images cache nahi hongi:', url.hostname); } catch (x) {}
    }
    return plain;
  }

  if (res.ok && res.status === 200) e.waitUntil(storeImage(cache, key, res.clone()).catch(() => false));
  return res;
}

/* ======================= MESSAGES ======================= */

self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d) return;

  if (d.type === 'CHECK_UPDATE') {
    e.waitUntil((async () => {
      try {
        const cache = await caches.open(STORE_CACHE);
        const r = await refreshPage(cache);
        if (r.changed) await notifyClients();
      } catch (err) {}
    })());
  }

  /* Saari cached images ko turant update-check karwao (index se: controller.postMessage({type:'REFRESH_IMAGES'})) */
  if (d.type === 'REFRESH_IMAGES') {
    e.waitUntil((async () => {
      try {
        const cache = await caches.open(IMG_CACHE);
        const keys = await cache.keys();
        await Promise.all(keys.map((k) => runLimited(() => recheckImage(k.url))));
      } catch (err) {}
    })());
  }

  /* Image cache poora saaf (zarurat par hi) */
  if (d.type === 'CLEAR_IMAGE_CACHE') {
    e.waitUntil(caches.delete(IMG_CACHE).then(() => {
      if (e.source && e.source.postMessage) e.source.postMessage({ type: 'PIKA_IMG_CACHE_CLEARED' });
    }));
  }
});

/* ======================= FETCH ROUTER ======================= */

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
      return;
    }
    if (isCacheableImage(url, req)) {
      e.respondWith(handleImage(e, req, url).catch(() => caches.match(req, { ignoreVary: true }).then((r) => r || Response.error())));
    }
    return;
  }

  if (isStaticFile(url)) {
    e.respondWith(cacheFirst(req).catch(() => caches.match(req).then((r) => r || Response.error())));
    return;
  }

  if (isCacheableImage(url, req)) {
    e.respondWith(handleImage(e, req, url).catch(() => caches.match(req, { ignoreVary: true }).then((r) => r || Response.error())));
  }
});
