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
const VERSION = '23';
const CACHE = 'chrono-v' + VERSION;

// La liste est **produite par la construction** (`tools/build_pwa.py`), qui
// sait exactement ce qu'elle a copié. Tenue à la main, elle prenait du retard
// en silence : trois fichiers du suivi y manquaient, et une installation faite
// puis coupée du réseau aurait ouvert une application privée de ses
// statistiques, sans le moindre message.
const ASSETS = [
  "./",
  "./apple-touch-icon.png",
  "./badges/badge-01.png",
  "./badges/badge-02.png",
  "./badges/badge-03.png",
  "./badges/badge-04.png",
  "./badges/badge-05.png",
  "./badges/badge-06.png",
  "./badges/badge-07.png",
  "./badges/badge-08.png",
  "./badges/badge-09.png",
  "./badges/badge-10.png",
  "./brand.png",
  "./chrono.css",
  "./chrono.js",
  "./flip.css",
  "./fonts/Inter-Bold.ttf",
  "./fonts/Inter-SemiBold.ttf",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./index.html",
  "./manifest.webmanifest",
  "./suivi-ui.js",
  "./suivi.css",
  "./suivi.js",
  "./timer.js"
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
