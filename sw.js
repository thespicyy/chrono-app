/*
 * Chrono — service worker.
 *
 * Stratégie « réseau d'abord », reprise de KeyMint et de la leçon payée sur la
 * PWA TDL : un cache-first restait collé à une vieille version sur iOS, et
 * aucun correctif n'arrivait jamais jusqu'à l'appareil. Ici le réseau gagne
 * dès qu'il répond ; le cache n'est qu'un filet pour le hors-ligne.
 *
 * Le numéro de version est injecté par tools/build_pwa.py.
 */
const VERSION = '2';
const CACHE = 'chrono-v' + VERSION;

const ASSETS = [
  './',
  './index.html',
  './chrono.css',
  './flip.css',
  './chrono.js',
  './timer.js',
  './manifest.webmanifest',
  './brand.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './fonts/Inter-SemiBold.ttf',
  './fonts/Inter-Bold.ttf'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((reponse) => {
        // On ne met en cache que ce qui est réellement servi : une réponse
        // d'erreur mise en cache se rejouerait hors ligne comme si de rien.
        if (reponse && reponse.ok) {
          const copie = reponse.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copie));
        }
        return reponse;
      })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('./index.html')))
  );
});
