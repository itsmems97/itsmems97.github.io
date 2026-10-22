const CACHE_NAME = 'pika-movie-v1';
const ASSETS = [
  '/',
  '/Pika-Movie.html',
  '/pika-movie-manifest.json',
  '/Pika-Movie.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});